import type { NextRequest } from "next/server";

/**
 * Receives a submission from /availability and writes it to Notion.
 *
 * 1. Always appends a row to the "Availability Submissions" log.
 * 2. Looks the volunteer up in the Volunteer Pipeline by email. If a row
 *    matches, it overwrites their Availability and unticks
 *    "Needs Full Availability" when they clear the 3 hour weekday bar.
 *
 * Requires one environment variable in Vercel:
 *   NOTION_TOKEN   an internal integration secret from notion.so/my-integrations
 *
 * Both databases must be shared with that integration in Notion.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const SUBMISSIONS_DB = "03d8864d0bdf48be84f86455542ff54a"; // Availability Submissions
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
  if (!res.ok) {
    throw new Error(`Notion ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function updatePipeline(p: Payload): Promise<boolean> {
  const found = await notion(`/databases/${PIPELINE_DB}/query`, "POST", {
    page_size: 1,
    filter: { property: "Email", email: { equals: p.email } },
  });

  const row = found?.results?.[0];
  if (!row) return false;

  const summary =
    DAYS.map((d) => `${d}: ${p.availabilityByDay[d] ?? "unavailable"}`).join(
      " | ",
    ) +
    ` || Total: ${p.totalHours} hr/week` +
    ` || Longest weekday block: ${p.longestWeekdayBlockHours} hr` +
    (p.notes ? ` || Notes: ${p.notes}` : "");

  await notion(`/pages/${row.id}`, "PATCH", {
    properties: {
      Availability: text(summary),
      "Needs Full Availability": { checkbox: !p.meetsWeekdayBlock },
    },
  });

  return true;
}

async function logSubmission(p: Payload, matched: boolean) {
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: p.name.slice(0, 200) } }] },
    Email: { email: p.email },
    Submitted: { date: { start: new Date().toISOString() } },
    "Total Hours": { number: p.totalHours },
    "Longest Weekday Block": { number: p.longestWeekdayBlockHours },
    "Meets 3hr Block": { checkbox: p.meetsWeekdayBlock },
    "Matched Pipeline Row": { checkbox: matched },
    Notes: text(p.notes || ""),
  };
  for (const d of DAYS) {
    properties[d] = text(p.availabilityByDay[d] ?? "unavailable");
  }

  await notion("/pages", "POST", {
    parent: { database_id: SUBMISSIONS_DB },
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

  // The pipeline update is best effort. A submission is never lost because
  // of a name mismatch or a missing row, it still lands in the log.
  let matched = false;
  try {
    matched = await updatePipeline(p);
  } catch (err) {
    console.error("availability: pipeline update failed", err);
  }

  try {
    await logSubmission(p, matched);
  } catch (err) {
    console.error("availability: log write failed", err);
    return Response.json({ ok: false, error: "log_failed" }, { status: 500 });
  }

  return Response.json({ ok: true, matched });
}
