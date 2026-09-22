import type { NextRequest } from "next/server";

/**
 * Receives a submission from /availability and writes it into the existing
 * Availability Profiles database, which is Natalie's source of truth for
 * placement scheduling.
 *
 * On each submission:
 *   1. Any prior non-superseded profile for that email is marked Superseded,
 *      which is what that field is for. Nothing is overwritten or deleted.
 *   2. A new profile row is created with Monday..Sunday filled in, linked back
 *      to the volunteer's Pipeline record when the email matches.
 *
 * Requires NOTION_TOKEN in the environment. The Availability Profiles and
 * Volunteer Pipeline databases must both be shared with that integration.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const AVAILABILITY_DB = "3e1d6c55a9de81148cc0e3615db31c72"; // Availability Profiles
const PIPELINE_DB = "03192649741442fe86acdddcc7320798"; // Volunteer Master

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

type Payload = {
  name: string;
  email: string;
  notes?: string;
  totalHours: number;
  longestWeekdayBlockHours: number;
  meetsWeekdayBlock: boolean;
  availabilityByDay: Record<string, string>;
};

function text(value: string) {
  return { rich_text: [{ text: { content: (value || "").slice(0, 2000) } }] };
}

async function notion(path: string, method: string, body?: unknown) {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

/** The volunteer's row in the Pipeline, so the new profile can relate to it. */
async function findPipelineRow(email: string): Promise<string | null> {
  const found = await notion(`/databases/${PIPELINE_DB}/query`, "POST", {
    page_size: 1,
    filter: { property: "Email", email: { equals: email } },
  });
  return found?.results?.[0]?.id ?? null;
}

/** Retire earlier schedules rather than editing them. */
async function supersedePrevious(email: string) {
  const prior = await notion(`/databases/${AVAILABILITY_DB}/query`, "POST", {
    page_size: 25,
    filter: {
      and: [
        { property: "Email", email: { equals: email } },
        { property: "Superseded", checkbox: { equals: false } },
      ],
    },
  });

  for (const row of prior?.results ?? []) {
    await notion(`/pages/${row.id}`, "PATCH", {
      properties: { Superseded: { checkbox: true } },
    });
  }
}

async function createProfile(p: Payload, pipelineRowId: string | null) {
  const missingDays = DAYS.filter(
    (d) => (p.availabilityByDay[d] ?? "unavailable") === "unavailable",
  );

  const properties: Record<string, unknown> = {
    Volunteer: { title: [{ text: { content: p.name.slice(0, 200) } }] },
    Email: { email: p.email },
    Source: { select: { name: "Google Form" } },
    "Source Timestamp": { date: { start: new Date().toISOString() } },
    "Source Sheet": { url: "https://www.campus2care.org/availability" },
    "Identity Status": { select: { name: pipelineRowId ? "Confirmed" : "Name only" } },
    // Every day was answered explicitly by the grid, so nothing is ambiguous.
    // The flag reflects whether the schedule is usable for placement.
    "Needs New Availability": { checkbox: !p.meetsWeekdayBlock },
    "Include in Scheduling": { checkbox: true },
    "Missing Days": { multi_select: missingDays.map((name) => ({ name })) },
    "Availability Notes":
      text(
        [
          `Total ${p.totalHours} hr/week`,
          `longest weekday block ${p.longestWeekdayBlockHours} hr`,
          p.notes ? `Student notes: ${p.notes}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
  };

  for (const d of DAYS) {
    properties[d] = text(p.availabilityByDay[d] ?? "Not available");
  }

  if (pipelineRowId) {
    properties["Volunteer Record"] = { relation: [{ id: pipelineRowId }] };
  }

  await notion("/pages", "POST", {
    parent: { database_id: AVAILABILITY_DB },
    properties,
  });
}

export async function POST(request: NextRequest) {
  if (!process.env.NOTION_TOKEN) {
    console.error("availability: NOTION_TOKEN is not set");
    return Response.json({ ok: false, error: "not_configured" }, { status: 500 });
  }

  let p: Payload;
  try {
    p = await request.json();
  } catch {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  if (!p?.name || !p?.email || !p?.availabilityByDay) {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const pipelineRowId = await findPipelineRow(p.email);
    await supersedePrevious(p.email);
    await createProfile(p, pipelineRowId);
    return Response.json({ ok: true, matched: Boolean(pipelineRowId) });
  } catch (err) {
    console.error("availability: write failed", err);
    return Response.json({ ok: false, error: "write_failed" }, { status: 500 });
  }
}
