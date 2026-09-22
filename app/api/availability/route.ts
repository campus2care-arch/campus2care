import type { NextRequest } from "next/server";

/**
 * Receives a submission from /availability.
 *
 * Two independent sinks, so a student's answers are never lost:
 *
 *   1. Availability Profiles in Notion. Always written, matched or not.
 *      When the submitter can be tied to a Volunteer Pipeline record the new
 *      profile is linked to it and marked Confirmed. When it cannot, the row
 *      is still created as "Name only" with a note saying what they typed, so
 *      it shows up in All Availability and can be linked by hand.
 *
 *   2. An optional Apps Script webhook (SHEET_WEBHOOK_URL) that appends to a
 *      Google Sheet. This is the backstop if Notion is down or misconfigured.
 *
 * Neither sink can fail the request. The student always gets a confirmation,
 * and anything that did not land is written to the function log verbatim.
 *
 * Env:
 *   NOTION_TOKEN        required for the Notion write
 *   SHEET_WEBHOOK_URL   optional Apps Script /exec URL
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

const AVAILABILITY_DB = "3e1d6c55a9de81148cc0e3615db31c72"; // Availability Profiles
const PIPELINE_DB = "03192649741442fe86acdddcc7320798"; // Volunteer Pipeline

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
  altEmail?: string;
  notes?: string;
  totalHours: number;
  longestWeekdayBlockHours: number;
  meetsWeekdayBlock: boolean;
  availabilityByDay: Record<string, string>;
};

type Candidate = {
  id: string;
  name: string;
  email: string;
};

type MatchResult = {
  id: string | null;
  how: string;
};

/* ------------------------------ normalizing ----------------------------- */

/** Lowercase, trim, drop +tags, and drop dots in the local part for Gmail. */
function normEmail(raw: string): string {
  const e = (raw || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain}`;
}

function localPart(raw: string): string {
  const e = normEmail(raw);
  const at = e.lastIndexOf("@");
  return at > 0 ? e.slice(0, at) : "";
}

/**
 * Strip accents, punctuation and honorifics so "O'Brien-Smith" and
 * "obrien smith" compare equal. Returns the words of the name.
 */
function nameWords(raw: string): string[] {
  return (raw || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !["mr", "ms", "mrs", "dr", "jr", "sr"].includes(w));
}

function normName(raw: string): string {
  return nameWords(raw).join(" ");
}

/* -------------------------------- Notion -------------------------------- */

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

function text(value: string) {
  return { rich_text: [{ text: { content: (value || "").slice(0, 2000) } }] };
}

function plain(prop: { rich_text?: { plain_text: string }[]; title?: { plain_text: string }[] }) {
  const parts = prop?.title ?? prop?.rich_text ?? [];
  return parts.map((t) => t.plain_text).join("");
}

/** Every Pipeline row, so matching can be done properly in memory. */
async function loadPipeline(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let cursor: string | undefined;

  do {
    const page = await notion(`/databases/${PIPELINE_DB}/query`, "POST", {
      page_size: 100,
      start_cursor: cursor,
    });
    for (const row of page?.results ?? []) {
      out.push({
        id: row.id,
        name: plain(row.properties?.Volunteer),
        email: row.properties?.Email?.email ?? "",
      });
    }
    cursor = page?.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return out;
}

/**
 * Find the volunteer, tolerating the two things that actually go wrong:
 * a different email than the one they applied with, and a different form
 * of their name. Name-based matches must be unambiguous, otherwise the
 * submission is left unmatched rather than attached to the wrong person.
 */
function matchVolunteer(p: Payload, rows: Candidate[]): MatchResult {
  const emails = [p.email, p.altEmail ?? ""].filter(Boolean).map(normEmail);
  const locals = [p.email, p.altEmail ?? ""].filter(Boolean).map(localPart);

  // 1. Same email, allowing for case, +tags and Gmail dots.
  const byEmail = rows.filter((r) => r.email && emails.includes(normEmail(r.email)));
  if (byEmail.length === 1) return { id: byEmail[0].id, how: "email" };

  // 2. Same username on a different domain: jsmith@bu.edu vs jsmith@gmail.com.
  const byLocal = rows.filter((r) => r.email && locals.includes(localPart(r.email)));
  if (byLocal.length === 1) return { id: byLocal[0].id, how: "email username" };

  // 3. Exact name.
  const submitted = normName(p.name);
  if (submitted) {
    const byName = rows.filter((r) => normName(r.name) === submitted);
    if (byName.length === 1) return { id: byName[0].id, how: "full name" };
  }

  // 4. Last name plus first initial, e.g. "Nat Barendse" -> "Natalie Barendse".
  const words = nameWords(p.name);
  if (words.length >= 2) {
    const last = words[words.length - 1];
    const initial = words[0][0];
    const byLast = rows.filter((r) => {
      const w = nameWords(r.name);
      return w.length >= 2 && w[w.length - 1] === last && w[0][0] === initial;
    });
    if (byLast.length === 1) return { id: byLast[0].id, how: "last name and first initial" };
  }

  return { id: null, how: "" };
}

/** Retire earlier schedules rather than editing them. */
async function supersedePrevious(p: Payload, pipelineRowId: string | null) {
  const or: unknown[] = [{ property: "Email", email: { equals: p.email } }];
  if (p.altEmail) or.push({ property: "Email", email: { equals: p.altEmail } });
  if (pipelineRowId) {
    or.push({ property: "Volunteer Record", relation: { contains: pipelineRowId } });
  }

  const prior = await notion(`/databases/${AVAILABILITY_DB}/query`, "POST", {
    page_size: 50,
    filter: {
      and: [{ or }, { property: "Superseded", checkbox: { equals: false } }],
    },
  });

  for (const row of prior?.results ?? []) {
    await notion(`/pages/${row.id}`, "PATCH", {
      properties: { Superseded: { checkbox: true } },
    });
  }
}

async function createProfile(p: Payload, match: MatchResult) {
  const missingDays = DAYS.filter(
    (d) => (p.availabilityByDay[d] ?? "unavailable") === "unavailable",
  );

  const noteParts = [
    `Total ${p.totalHours} hr/week`,
    `longest weekday block ${p.longestWeekdayBlockHours} hr`,
  ];
  if (p.altEmail) noteParts.push(`Also gave ${p.altEmail}`);
  if (match.id) {
    noteParts.push(`Matched on ${match.how}`);
  } else {
    noteParts.push(
      `NO PIPELINE MATCH - submitted as "${p.name}" <${p.email}>. Link by hand.`,
    );
  }
  if (p.notes) noteParts.push(`Student notes: ${p.notes}`);

  const properties: Record<string, unknown> = {
    Volunteer: { title: [{ text: { content: p.name.slice(0, 200) } }] },
    Email: { email: p.email },
    Source: { select: { name: "Weekly Grid" } },
    "Source Timestamp": { date: { start: new Date().toISOString() } },
    "Source Sheet": { url: "https://www.campus2care.org/availability" },
    // "Name only" rather than "Unidentified" on purpose: Unidentified rows are
    // filtered out of all three views on the Availability page, so an unmatched
    // submission would be saved but invisible.
    "Identity Status": { select: { name: match.id ? "Confirmed" : "Name only" } },
    "Needs New Availability": { checkbox: !p.meetsWeekdayBlock },
    "Include in Scheduling": { checkbox: true },
    "Missing Days": { multi_select: missingDays.map((name) => ({ name })) },
    "Availability Notes": text(noteParts.join(" · ")),
  };

  for (const d of DAYS) {
    properties[d] = text(p.availabilityByDay[d] ?? "Not available");
  }

  if (match.id) {
    properties["Volunteer Record"] = { relation: [{ id: match.id }] };
  }

  await notion("/pages", "POST", {
    parent: { database_id: AVAILABILITY_DB },
    properties,
  });
}

async function writeToNotion(p: Payload): Promise<MatchResult> {
  const rows = await loadPipeline();
  const match = matchVolunteer(p, rows);
  await supersedePrevious(p, match.id);
  await createProfile(p, match);
  return match;
}

/* ------------------------------- backstop ------------------------------- */

/** Append to the Google Sheet, if one is wired up. Never throws. */
async function writeToSheet(p: Payload) {
  const url = process.env.SHEET_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...p, submittedAt: new Date().toISOString() }),
  });
}

/* --------------------------------- route -------------------------------- */

export async function POST(request: NextRequest) {
  let p: Payload;
  try {
    p = await request.json();
  } catch {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  if (!p?.name || !p?.email || !p?.availabilityByDay) {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  // Both sinks run regardless of each other's outcome.
  const [notionResult, sheetResult] = await Promise.allSettled([
    process.env.NOTION_TOKEN
      ? writeToNotion(p)
      : Promise.reject(new Error("NOTION_TOKEN is not set")),
    writeToSheet(p),
  ]);

  const saved = notionResult.status === "fulfilled" || sheetResult.status === "fulfilled";

  if (notionResult.status === "rejected") {
    console.error("availability: Notion write failed", notionResult.reason);
  }
  if (sheetResult.status === "rejected") {
    console.error("availability: Sheet write failed", sheetResult.reason);
  }
  if (!saved) {
    // Last resort. The log is the record until someone fixes the config.
    console.error("availability: UNSAVED SUBMISSION", JSON.stringify(p));
    return Response.json({ ok: false, error: "write_failed" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    matched: notionResult.status === "fulfilled" && Boolean(notionResult.value.id),
  });
}
