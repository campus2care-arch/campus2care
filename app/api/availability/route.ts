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

// The Availability page shows a LINKED VIEW of this database. The view has its
// own id (3e1d6c55a9de81148cc0e3615db31c72) that the REST API cannot write to.
// This is the real source database, under Archive / Legacy Availability & Scheduling.
const AVAILABILITY_DB = "70a49d16d3474eb8af9204a6404f6af3"; // Availability Profiles
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
  submissionId?: string;
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
  alternateEmail: string;
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
        alternateEmail: row.properties?.["Alternate Email"]?.email ?? "",
      });
    }
    cursor = page?.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return out;
}

/**
 * Email is the primary identity key. Exact full name is the only fallback,
 * and name matches must be unambiguous. This deliberately avoids attaching a
 * schedule based only on an email username or a last name and initial.
 */
function matchVolunteer(p: Payload, rows: Candidate[]): MatchResult {
  const emails = [p.email, p.altEmail ?? ""].filter(Boolean).map(normEmail);

  // 1. Same email, allowing for case, +tags and Gmail dots.
  const byEmail = rows.filter((r) =>
    [r.email, r.alternateEmail]
      .filter(Boolean)
      .some((email) => emails.includes(normEmail(email))),
  );
  if (byEmail.length === 1) return { id: byEmail[0].id, how: "email" };

  // 2. Exact full name, only when unique.
  const submitted = normName(p.name);
  if (submitted) {
    const byName = rows.filter((r) => normName(r.name) === submitted);
    if (byName.length === 1) return { id: byName[0].id, how: "full name" };
  }

  return { id: null, how: "" };
}

/** Find earlier schedules before creating the replacement. */
async function findPrevious(p: Payload, pipelineRowId: string | null) {
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

  return prior?.results ?? [];
}

async function createProfile(p: Payload, match: MatchResult) {
  const missingDays = DAYS.filter((d) => !p.availabilityByDay[d]?.trim());

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
    "Submission ID": text(p.submissionId ?? ""),
    // "Name only" rather than "Unidentified" on purpose: Unidentified rows are
    // filtered out of all three views on the Availability page, so an unmatched
    // submission would be saved but invisible.
    "Identity Status": { select: { name: match.id ? "Confirmed" : "Name only" } },
    "Needs New Availability": { checkbox: missingDays.length > 0 },
    "Include in Scheduling": { checkbox: true },
    Superseded: { checkbox: false },
    "Missing Days": { multi_select: missingDays.map((name) => ({ name })) },
    "Total Weekly Hours": { number: p.totalHours },
    "Meets Weekday Block": { checkbox: p.meetsWeekdayBlock },
    "Availability Notes": text(noteParts.join(" · ")),
  };

  for (const d of DAYS) {
    properties[d] = text(p.availabilityByDay[d] ?? "Not available");
  }

  if (match.id) {
    properties["Volunteer Record"] = { relation: [{ id: match.id }] };
  }

  const created = await notion("/pages", "POST", {
    parent: { database_id: AVAILABILITY_DB },
    properties,
  });
  return created.id as string;
}

async function writeToNotion(p: Payload): Promise<MatchResult> {
  if (p.submissionId) {
    const duplicate = await notion(`/databases/${AVAILABILITY_DB}/query`, "POST", {
      page_size: 10,
      filter: { property: "Submission ID", rich_text: { equals: p.submissionId } },
    });
    if ((duplicate?.results ?? []).length === 1) {
      return { id: null, how: "duplicate submission" };
    }
  }
  const rows = await loadPipeline();
  const match = matchVolunteer(p, rows);
  const previous = await findPrevious(p, match.id);
  const createdId = await createProfile(p, match);
  for (const row of previous) {
    if (row.id === createdId) continue;
    await notion(`/pages/${row.id}`, "PATCH", {
      properties: { Superseded: { checkbox: true } },
    });
  }
  if (match.id) {
    await notion(`/pages/${match.id}`, "PATCH", {
      properties: { "Needs Full Availability": { checkbox: false } },
    });
  }
  return match;
}

/* ------------------------------- backstop ------------------------------- */

/**
 * Append to the Google Sheet, if one is wired up.
 *
 * Returns true ONLY when a row was actually written. An unconfigured webhook
 * returns false rather than resolving quietly, because a sink that did nothing
 * must never be counted as a successful save.
 */
async function writeToSheet(p: Payload): Promise<boolean> {
  const url = process.env.SHEET_WEBHOOK_URL;
  if (!url) return false;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...p, submittedAt: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Sheet ${res.status}`);
  return true;
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

  const notionSaved = notionResult.status === "fulfilled";
  const sheetSaved = sheetResult.status === "fulfilled" && sheetResult.value === true;
  const saved = notionSaved || sheetSaved;

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
