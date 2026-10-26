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
const BU_AVAILABILITY_DB = "70a49d16d3474eb8af9204a6404f6af3";
const BU_PIPELINE_DB = "03192649741442fe86acdddcc7320798";
const BC_PIPELINE_DB = "bc8eaec9a5d449cd87426e8613299a93";
const BC_AVAILABILITY_DB = "31524183bec6431ba82fc4b79114286b";
const IS_PRODUCTION = process.env.VERCEL_ENV === "production";
const NOTION_TOKEN = (IS_PRODUCTION ? process.env.NOTION_TOKEN : process.env.NOTION_PREVIEW_TOKEN)?.trim() ?? "";
const PIPELINE_DB = IS_PRODUCTION ? BU_PIPELINE_DB : process.env.NOTION_PIPELINE_DATABASE_ID?.trim() ?? "";
const AVAILABILITY_DB = IS_PRODUCTION ? BU_AVAILABILITY_DB : process.env.NOTION_AVAILABILITY_DATABASE_ID?.trim() ?? "";

function targetIsSafe() {
  if (!NOTION_TOKEN) return false;
  if (IS_PRODUCTION) return true;
  const normalize = (id: string) => id.replace(/-/g, "").toLowerCase();
  const reserved = new Set([BU_PIPELINE_DB, BU_AVAILABILITY_DB, BC_PIPELINE_DB, BC_AVAILABILITY_DB].map(normalize));
  return Boolean(PIPELINE_DB && AVAILABILITY_DB &&
    normalize(PIPELINE_DB) !== normalize(AVAILABILITY_DB) &&
    !reserved.has(normalize(PIPELINE_DB)) && !reserved.has(normalize(AVAILABILITY_DB)));
}

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
  universityChoice?: "bu" | "bc" | "other";
  otherUniversity?: string;
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
      Authorization: `Bearer ${NOTION_TOKEN}`,
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
async function loadPipeline(pipelineDb = PIPELINE_DB): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let cursor: string | undefined;

  do {
    const page = await notion(`/databases/${pipelineDb}/query`, "POST", {
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
  if (byEmail.length > 1) throw new Error("ambiguous_email");
  if (byEmail.length === 1) return { id: byEmail[0].id, how: "email" };

  // Names only establish identity when the existing volunteer has no usable email.
  // Never attach a schedule to a different verified email because a name matched.
  const submitted = normName(p.name);
  if (submitted) {
    const byName = rows.filter((r) => normName(r.name) === submitted);
    if (byName.length > 1) throw new Error("ambiguous_name");
    if (byName.length === 1) {
      const row = byName[0];
      if (!row.email && !row.alternateEmail) return { id: row.id, how: "full name, no saved email" };
    }
  }

  return { id: null, how: "" };
}

/** Find earlier schedules before creating the replacement. */
async function findPrevious(p: Payload, pipelineRowId: string | null, availabilityDb = AVAILABILITY_DB) {
  const or: unknown[] = [{ property: "Email", email: { equals: p.email } }];
  if (p.altEmail) or.push({ property: "Email", email: { equals: p.altEmail } });
  if (pipelineRowId) {
    or.push({ property: "Volunteer Record", relation: { contains: pipelineRowId } });
  }

  const prior = await notion(`/databases/${availabilityDb}/query`, "POST", {
    page_size: 50,
    filter: {
      and: [{ or }, { property: "Superseded", checkbox: { equals: false } }],
    },
  });

  return prior?.results ?? [];
}

async function createProfile(p: Payload, match: MatchResult, availabilityDb = AVAILABILITY_DB) {
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
  if (p.universityChoice) noteParts.push(`University: ${p.universityChoice === "bc" ? "Boston College" : p.universityChoice === "bu" ? "Boston University" : p.otherUniversity}`);

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
    parent: { database_id: availabilityDb },
    properties,
  });
  return created.id as string;
}

async function writeToNotion(p: Payload): Promise<MatchResult> {
  const campus = p.universityChoice === "bc" ? "BC" : "BU";
  const pipelineDb = campus === "BC" ? BC_PIPELINE_DB : PIPELINE_DB;
  const availabilityDb = campus === "BC" ? BC_AVAILABILITY_DB : AVAILABILITY_DB;
  const rows = await loadPipeline(pipelineDb);
  const match = matchVolunteer(p, rows);
  const duplicate = await notion(`/databases/${availabilityDb}/query`, "POST", {
    page_size: 10,
    filter: { property: "Submission ID", rich_text: { equals: p.submissionId } },
  });
  if ((duplicate?.results ?? []).length > 1) throw new Error("duplicate_submission_profiles");
  const existing = duplicate?.results?.[0];
  if (existing) {
    const linked: { id: string }[] = existing.properties?.["Volunteer Record"]?.relation ?? [];
    const existingEmail: string = existing.properties?.Email?.email ?? "";
    if (normEmail(existingEmail) !== normEmail(p.email) ||
        existing.properties?.Superseded?.checkbox === true ||
        (match.id ? linked.length !== 1 || linked[0].id !== match.id : linked.length > 0)) {
      throw new Error("availability_profile_conflict");
    }
  }
  const previous = await findPrevious(p, match.id, availabilityDb);
  for (const row of previous) {
    const linked: { id: string }[] = row.properties?.["Volunteer Record"]?.relation ?? [];
    if (linked.length > 0 && (!match.id || linked.length !== 1 || linked[0].id !== match.id)) {
      throw new Error("availability_profile_conflict");
    }
  }
  const createdId: string = existing?.id ?? await createProfile(p, match, availabilityDb);
  // A partial failure after creation can be safely retried: supersede older rows
  // without creating a second profile for the same submission ID.
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

  const schoolName = p?.universityChoice === "other" ? p.otherUniversity?.trim() ?? "" : "";
  const schoolKey = schoolName.toLowerCase().replace(/[^a-z]/g, "");
  const validEmail = (email: string) => /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email);
  if (!p || typeof p.name !== "string" || !p.name.trim() || p.name.length > 200 ||
      typeof p.email !== "string" || !validEmail(p.email) ||
      (p.altEmail && (typeof p.altEmail !== "string" || !validEmail(p.altEmail))) ||
      typeof p.submissionId !== "string" || !p.submissionId.trim() || p.submissionId.length > 200 ||
      (p.universityChoice && !["bu", "bc", "other"].includes(p.universityChoice)) ||
      (p.universityChoice === "other" && (!schoolName || schoolName.length > 500 || ["bc", "bostoncollege"].includes(schoolKey))) ||
      !p.availabilityByDay || typeof p.availabilityByDay !== "object" ||
      DAYS.some((day) => typeof p.availabilityByDay[day] !== "string" || !p.availabilityByDay[day].trim()) ||
      !Number.isFinite(p.totalHours) || p.totalHours <= 0 || p.totalHours > 105 ||
      !Number.isFinite(p.longestWeekdayBlockHours) || typeof p.meetsWeekdayBlock !== "boolean") {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  p.name = p.name.trim();
  p.email = p.email.trim().toLowerCase();
  p.altEmail = p.altEmail?.trim().toLowerCase() ?? "";
  p.notes = typeof p.notes === "string" ? p.notes.trim().slice(0, 1400) : "";
  p.otherUniversity = schoolName;
  if (!targetIsSafe() || (p.universityChoice === "bc" && !IS_PRODUCTION)) {
    return Response.json({ ok: false, error: "service_unavailable" }, { status: 503 });
  }
  // Both sinks run regardless of each other's outcome.
  const [notionResult, sheetResult] = await Promise.allSettled([
    writeToNotion(p),
    IS_PRODUCTION && p.universityChoice !== "bc" ? writeToSheet(p) : Promise.resolve(false),
  ]);

  const notionSaved = notionResult.status === "fulfilled";
  const saved = notionSaved; // Backup alone cannot certify campus-specific Notion delivery.

  if (notionResult.status === "rejected") {
    console.error("availability: Notion write failed", notionResult.reason);
  }
  if (sheetResult.status === "rejected") {
    console.error("availability: Sheet write failed", sheetResult.reason);
  }
  if (!saved) {
    console.error("availability: UNSAVED SUBMISSION", p.submissionId, p.universityChoice ?? "legacy-bu");
    const reason = notionResult.status === "rejected" ? String(notionResult.reason) : "";
    return Response.json({ ok: false, error: /ambiguous_|availability_profile_conflict|duplicate_submission_profiles/.test(reason) ? "identity_conflict" : "write_failed" },
      { status: /ambiguous_|availability_profile_conflict|duplicate_submission_profiles/.test(reason) ? 409 : 500 });
  }

  return Response.json({
    ok: true,
    matched: notionResult.status === "fulfilled" && Boolean(notionResult.value.id),
  });
}
