import { NextResponse } from "next/server";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PROFILE_DATABASE_ID = process.env.NOTION_AVAILABILITY_PROFILE_DATABASE_ID;
const WINDOWS_DATABASE_ID = process.env.NOTION_AVAILABILITY_WINDOWS_DATABASE_ID;
const VOLUNTEER_DATABASE_ID = process.env.NOTION_VOLUNTEER_PIPELINE_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";

type Window = { day: string; start: string; end: string };

const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"] as const;

async function notion(path: string, method: "POST" | "PATCH", body: unknown) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN is not configured.");
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.message || "Notion request failed.");
  return json;
}

function title(content: string) {
  return { title: [{ text: { content } }] };
}

function rich(content: string) {
  return { rich_text: content ? [{ text: { content } }] : [] };
}

function minutes(value: string) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function displayTime(value: string) {
  if (value === "24:00") return "midnight";
  const [hourRaw, minuteRaw] = value.split(":").map(Number);
  const suffix = hourRaw >= 12 ? "PM" : "AM";
  const hour = hourRaw % 12 || 12;
  return `${hour}:${String(minuteRaw).padStart(2, "0")} ${suffix}`;
}

function dailySummary(windows: Window[], day: string) {
  const dayWindows = windows
    .filter((w) => w.day === day)
    .sort((a, b) => minutes(a.start) - minutes(b.start));
  if (!dayWindows.length) return "Unavailable";
  return dayWindows.map((w) => `${displayTime(w.start)}–${displayTime(w.end)}`).join("; ");
}

function plainTitle(property: any) {
  return property?.title?.map((part: any) => part?.plain_text || part?.text?.content || "").join("").trim();
}

export async function POST(req: Request) {
  try {
    if (!PROFILE_DATABASE_ID || !WINDOWS_DATABASE_ID || !VOLUNTEER_DATABASE_ID) {
      return NextResponse.json({ error: "Notion database IDs are not configured." }, { status: 500 });
    }

    const { name, email, notes, windows } = await req.json() as {
      name: string;
      email: string;
      notes?: string;
      windows: Window[];
    };

    const normalizedEmail = email?.trim().toLowerCase();

    if (!name?.trim() || !normalizedEmail || !Array.isArray(windows) || !windows.length) {
      return NextResponse.json({ error: "Name, email, and at least one availability block are required." }, { status: 400 });
    }

    const invalidWindow = windows.some((w) => {
      const start = minutes(w.start);
      const end = minutes(w.end);
      return !DAYS.includes(w.day as any) || start < 8 * 60 || end > 24 * 60 || end <= start;
    });
    if (invalidWindow) {
      return NextResponse.json({ error: "Availability must stay between 8:00 AM and midnight." }, { status: 400 });
    }

    const applicantSearch = await notion(`databases/${VOLUNTEER_DATABASE_ID}/query`, "POST", {
      filter: { property: "Email", email: { equals: normalizedEmail } },
      page_size: 2,
    });

    if (!applicantSearch.results?.length) {
      return NextResponse.json(
        { error: "We could not match that email to the Campus2Care volunteer pipeline. Use the same email you applied with." },
        { status: 400 }
      );
    }

    const applicant = applicantSearch.results[0];
    const officialName = plainTitle(applicant.properties?.Volunteer) || name.trim();
    const cohort = applicant.properties?.Cohort?.select?.name || "Unassigned";

    // Preserve history. Older schedules are never deleted; they are simply retired.
    const previousProfiles = await notion(`databases/${PROFILE_DATABASE_ID}/query`, "POST", {
      filter: { property: "Email", email: { equals: normalizedEmail } },
      page_size: 100,
    });

    for (const oldProfile of previousProfiles.results || []) {
      await notion(`pages/${oldProfile.id}`, "PATCH", {
        properties: {
          "Superseded": { checkbox: true },
          "Include in Scheduling": { checkbox: false },
        },
      });

      const oldWindows = await notion(`databases/${WINDOWS_DATABASE_ID}/query`, "POST", {
        filter: { property: "Source Profile", relation: { contains: oldProfile.id } },
        page_size: 100,
      });

      for (const oldWindow of oldWindows.results || []) {
        await notion(`pages/${oldWindow.id}`, "PATCH", {
          properties: { "Superseded": { checkbox: true } },
        });
      }
    }

    const dailyProperties = Object.fromEntries(
      DAYS.map((day) => [day, rich(dailySummary(windows, day))])
    );

    const profile = await notion("pages", "POST", {
      parent: { database_id: PROFILE_DATABASE_ID },
      properties: {
        "Person / Response": title(officialName),
        "Email": { email: normalizedEmail },
        "Identity Status": { select: { name: "Confirmed" } },
        "Source": { select: { name: "Weekly Grid" } },
        "Cohort": { select: { name: cohort } },
        "Placement Scope": { select: { name: "In-person" } },
        "Include in Scheduling": { checkbox: true },
        "Needs New Availability": { checkbox: false },
        "Missing Days": { multi_select: [] },
        "Superseded": { checkbox: false },
        "Availability Notes": rich(notes || "Confirmed through the Campus2Care weekly availability grid."),
        "Source Timestamp": { date: { start: new Date().toISOString() } },
        "Volunteer Record": { relation: [{ id: applicant.id }] },
        ...dailyProperties,
      }
    });

    for (const w of windows) {
      await notion("pages", "POST", {
        parent: { database_id: WINDOWS_DATABASE_ID },
        properties: {
          "Availability Window": title(`${officialName} · ${w.day}`),
          "Person": rich(officialName),
          "Day": { select: { name: w.day } },
          "Start": rich(w.start),
          "End": rich(w.end),
          "Recurrence": { select: { name: "Weekly" } },
          "Scheduling Status": { select: { name: "Ready" } },
          "Scope": { select: { name: "In-person" } },
          "Superseded": { checkbox: false },
          "Original Response": rich("Submitted through weekly grid"),
          "Source Profile": { relation: [{ id: profile.id }] },
        }
      });
    }

    return NextResponse.json({ ok: true, name: officialName, cohort });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save availability.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
