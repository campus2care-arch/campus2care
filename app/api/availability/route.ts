import { NextResponse } from "next/server";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PROFILE_DATABASE_ID = process.env.NOTION_AVAILABILITY_PROFILE_DATABASE_ID;
const WINDOWS_DATABASE_ID = process.env.NOTION_AVAILABILITY_WINDOWS_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";

type Window = { day: string; start: string; end: string };

async function notion(path: string, body: unknown) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN is not configured.");
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method: "POST",
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

export async function POST(req: Request) {
  try {
    if (!PROFILE_DATABASE_ID || !WINDOWS_DATABASE_ID) {
      return NextResponse.json({ error: "Notion database IDs are not configured." }, { status: 500 });
    }

    const { name, email, cohort, notes, windows } = await req.json() as {
      name: string;
      email: string;
      cohort: string;
      notes?: string;
      windows: Window[];
    };

    if (!name || !email || !Array.isArray(windows) || !windows.length) {
      return NextResponse.json({ error: "Name, email, and availability are required." }, { status: 400 });
    }

    const daysWithWindows = new Set(windows.map((w) => w.day));
    const allDays = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
    const missingDays = allDays.filter((d) => !daysWithWindows.has(d));

    const profile = await notion("pages", {
      parent: { database_id: PROFILE_DATABASE_ID },
      properties: {
        "Person / Response": title(name),
        "Email": { email },
        "Identity Status": { select: { name: "Confirmed" } },
        "Source": { select: { name: "Weekly Grid" } },
        "Cohort": { select: { name: cohort || "Unassigned" } },
        "Placement Scope": { select: { name: "In-person" } },
        "Include in Scheduling": { checkbox: true },
        "Needs New Availability": { checkbox: false },
        "Missing Days": { multi_select: missingDays.map((name) => ({ name })) },
        "Availability Notes": rich(notes || "Submitted through the Campus2Care weekly availability grid.")
      }
    });

    for (const w of windows) {
      await notion("pages", {
        parent: { database_id: WINDOWS_DATABASE_ID },
        properties: {
          "Availability Window": title(`${name} · ${w.day}`),
          "Person": rich(name),
          "Day": { select: { name: w.day } },
          "Start": rich(w.start),
          "End": rich(w.end),
          "Recurrence": { select: { name: "Weekly" } },
          "Scheduling Status": { select: { name: "Ready" } },
          "Scope": { select: { name: "In-person" } },
          "Original Response": rich("Submitted through weekly grid"),
          "Source Profile": { relation: [{ id: profile.id }] }
        }
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save availability.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
