import type { NextRequest } from "next/server";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PIPELINE_DB = "03192649741442fe86acdddcc7320798";
const AVAILABILITY_DB = "70a49d16d3474eb8af9204a6404f6af3";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

type YesNo = "Yes" | "No";
type Payload = {
  submissionId: string;
  fullName: string;
  email: string;
  alternateEmail?: string;
  phone?: string;
  school: string;
  graduationYear: number;
  major: string;
  clinicalCertification: YesNo;
  priorClinicalExperience: YesNo;
  comfortableWithPatients: YesNo;
  preferredStartDate: string;
  weeklyCommitmentHours: number;
  motivation: string;
  referralSource: string;
  availabilityNotes?: string;
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
  submissionId: string;
};

type Match = { id: string; kind: "submission" | "email" | "name" } | null;

function normEmail(raw: string): string {
  const value = (raw || "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return value;
  let local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replace(/\./g, "");
  }
  return `${local}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

function normName(raw: string): string {
  return (raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function validEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function textValue(value: string) {
  return { rich_text: [{ text: { content: value.slice(0, 2000) } }] };
}

function plain(prop: {
  rich_text?: { plain_text: string }[];
  title?: { plain_text: string }[];
}) {
  return (prop?.title ?? prop?.rich_text ?? [])
    .map((item) => item.plain_text)
    .join("");
}

async function notion(path: string, method: string, body?: unknown) {
  const response = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Notion ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function loadPipeline(): Promise<Candidate[]> {
  const rows: Candidate[] = [];
  let cursor: string | undefined;
  do {
    const page = await notion(`/databases/${PIPELINE_DB}/query`, "POST", {
      page_size: 100,
      start_cursor: cursor,
    });
    for (const row of page?.results ?? []) {
      rows.push({
        id: row.id,
        name: plain(row.properties?.Volunteer),
        email: row.properties?.Email?.email ?? "",
        alternateEmail: row.properties?.["Alternate Email"]?.email ?? "",
        submissionId: plain(row.properties?.["Application Submission ID"]),
      });
    }
    cursor = page?.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}

function matchApplicant(payload: Payload, rows: Candidate[]): Match {
  const bySubmission = rows.filter(
    (row) => row.submissionId && row.submissionId === payload.submissionId,
  );
  if (bySubmission.length === 1) {
    return { id: bySubmission[0].id, kind: "submission" };
  }
  if (bySubmission.length > 1) throw new Error("ambiguous_submission_id");

  const submittedEmails = [payload.email, payload.alternateEmail ?? ""]
    .filter(Boolean)
    .map(normEmail);
  const byEmail = rows.filter((row) =>
    [row.email, row.alternateEmail]
      .filter(Boolean)
      .map(normEmail)
      .some((email) => submittedEmails.includes(email)),
  );
  if (byEmail.length === 1) return { id: byEmail[0].id, kind: "email" };
  if (byEmail.length > 1) throw new Error("ambiguous_email");

  const submittedName = normName(payload.fullName);
  const byName = rows.filter(
    (row) => submittedName && normName(row.name) === submittedName,
  );
  if (byName.length === 1) return { id: byName[0].id, kind: "name" };
  if (byName.length > 1) throw new Error("ambiguous_name");
  return null;
}

function validate(raw: unknown): Payload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<Payload>;
  const requiredStrings: (keyof Payload)[] = [
    "submissionId",
    "fullName",
    "email",
    "school",
    "major",
    "clinicalCertification",
    "priorClinicalExperience",
    "comfortableWithPatients",
    "preferredStartDate",
    "motivation",
    "referralSource",
  ];
  if (requiredStrings.some((key) => typeof p[key] !== "string" || !String(p[key]).trim())) {
    return null;
  }
  if (!validEmail(String(p.email).trim())) return null;
  if (p.alternateEmail && !validEmail(String(p.alternateEmail).trim())) return null;
  if (![p.clinicalCertification, p.priorClinicalExperience, p.comfortableWithPatients].every((v) => v === "Yes" || v === "No")) return null;
  if (!Number.isInteger(p.graduationYear) || Number(p.graduationYear) < 2024 || Number(p.graduationYear) > 2040) return null;
  if (!Number.isFinite(p.weeklyCommitmentHours) || Number(p.weeklyCommitmentHours) < 1 || Number(p.weeklyCommitmentHours) > 40) return null;
  if (!Number.isFinite(p.totalHours) || Number(p.totalHours) <= 0 || Number(p.totalHours) > 105) return null;
  if (!p.availabilityByDay || typeof p.availabilityByDay !== "object") return null;
  if (DAYS.some((day) => typeof p.availabilityByDay?.[day] !== "string" || !p.availabilityByDay[day].trim())) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.preferredStartDate))) return null;

  return {
    ...(p as Payload),
    fullName: String(p.fullName).trim().slice(0, 200),
    email: String(p.email).trim().toLowerCase(),
    alternateEmail: String(p.alternateEmail ?? "").trim().toLowerCase(),
    phone: String(p.phone ?? "").trim().slice(0, 100),
    school: String(p.school).trim().slice(0, 500),
    major: String(p.major).trim().slice(0, 500),
    motivation: String(p.motivation).trim().slice(0, 2000),
    referralSource: String(p.referralSource).trim().slice(0, 500),
    availabilityNotes: String(p.availabilityNotes ?? "").trim().slice(0, 1500),
  };
}

function applicationProperties(p: Payload) {
  return {
    Volunteer: { title: [{ text: { content: p.fullName } }] },
    Email: { email: p.email },
    "Alternate Email": { email: p.alternateEmail || null },
    Phone: { phone_number: p.phone || null },
    School: textValue(p.school),
    "Graduation Year": { number: p.graduationYear },
    Major: textValue(p.major),
    "Clinical Certification": { select: { name: p.clinicalCertification } },
    "Prior Clinical Experience": { select: { name: p.priorClinicalExperience } },
    "Comfortable With Patients": { select: { name: p.comfortableWithPatients } },
    "Preferred Start Date": { date: { start: p.preferredStartDate } },
    "Weekly Commitment Hours": { number: p.weeklyCommitmentHours },
    "Application Motivation": textValue(p.motivation),
    "Referral Source": textValue(p.referralSource),
    "Application Submission ID": textValue(p.submissionId),
    "Application Submitted": { checkbox: true },
    "Application Date": { date: { start: new Date().toISOString() } },
    "Application Source": { select: { name: "Website Application" } },
  };
}

async function ensurePipeline(p: Payload, match: Match) {
  const properties: Record<string, unknown> = applicationProperties(p);
  if (match) {
    properties["Needs Full Availability"] = { checkbox: true };
    await notion(`/pages/${match.id}`, "PATCH", { properties });
    return { id: match.id, created: false, matchKind: match.kind };
  }

  Object.assign(properties, {
    "Needs Full Availability": { checkbox: true },
    Stage: { select: { name: "Needs Interview" } },
    "Interview Status": { select: { name: "Not Scheduled" } },
    "Next Step": { select: { name: "Schedule interview" } },
    "Workflow Status": { select: { name: "Application Received" } },
    Cohort: { select: { name: "Unassigned" } },
    "Workshop Status": { select: { name: "Not Scheduled" } },
    Owner: { select: { name: "Unassigned" } },
    "Secretary Owner": { select: { name: "Unassigned" } },
  });

  const created = await notion("/pages", "POST", {
    parent: { database_id: PIPELINE_DB },
    properties,
  });
  return { id: created.id as string, created: true, matchKind: "new" as const };
}

async function findAvailabilityBySubmission(submissionId: string) {
  const result = await notion(`/databases/${AVAILABILITY_DB}/query`, "POST", {
    page_size: 10,
    filter: { property: "Submission ID", rich_text: { equals: submissionId } },
  });
  return result?.results ?? [];
}

async function findCurrentAvailability(pipelineId: string) {
  const result = await notion(`/databases/${AVAILABILITY_DB}/query`, "POST", {
    page_size: 100,
    filter: {
      and: [
        { property: "Volunteer Record", relation: { contains: pipelineId } },
        { property: "Superseded", checkbox: { equals: false } },
      ],
    },
  });
  return result?.results ?? [];
}

async function createAvailability(p: Payload, pipelineId: string, matchedBy: string) {
  const existing = await findAvailabilityBySubmission(p.submissionId);
  if (existing.length === 1) return existing[0].id as string;
  if (existing.length > 1) throw new Error("duplicate_submission_profiles");

  const previous = await findCurrentAvailability(pipelineId);
  const noteParts = [
    `Website application; matched by ${matchedBy}`,
    `longest weekday block ${p.longestWeekdayBlockHours} hr`,
  ];
  if (p.alternateEmail) noteParts.push(`alternate email ${p.alternateEmail}`);
  if (p.availabilityNotes) noteParts.push(`student notes: ${p.availabilityNotes}`);

  const properties: Record<string, unknown> = {
    Volunteer: { title: [{ text: { content: p.fullName } }] },
    Email: { email: p.email },
    Source: { select: { name: "Website Application" } },
    "Source Timestamp": { date: { start: new Date().toISOString() } },
    "Source Sheet": { url: "https://www.campus2care.org/application" },
    "Submission ID": textValue(p.submissionId),
    "Identity Status": { select: { name: "Confirmed" } },
    "Volunteer Record": { relation: [{ id: pipelineId }] },
    "Needs New Availability": { checkbox: false },
    "Include in Scheduling": { checkbox: true },
    Superseded: { checkbox: false },
    "Missing Days": { multi_select: [] },
    "Total Weekly Hours": { number: p.totalHours },
    "Meets Weekday Block": { checkbox: p.meetsWeekdayBlock },
    "Availability Notes": textValue(noteParts.join(" · ")),
  };
  for (const day of DAYS) properties[day] = textValue(p.availabilityByDay[day]);

  const created = await notion("/pages", "POST", {
    parent: { database_id: AVAILABILITY_DB },
    properties,
  });

  for (const row of previous) {
    if (row.id === created.id) continue;
    await notion(`/pages/${row.id}`, "PATCH", {
      properties: { Superseded: { checkbox: true } },
    });
  }
  return created.id as string;
}

export async function POST(request: NextRequest) {
  if (!process.env.NOTION_TOKEN) {
    console.error("application: NOTION_TOKEN is not set");
    return Response.json({ ok: false, error: "service_unavailable" }, { status: 503 });
  }

  let payload: Payload | null = null;
  try {
    payload = validate(await request.json());
  } catch {
    // Validation response below is intentionally generic for applicants.
  }
  if (!payload) {
    return Response.json({ ok: false, error: "invalid_application" }, { status: 400 });
  }

  try {
    const match = matchApplicant(payload, await loadPipeline());
    const pipeline = await ensurePipeline(payload, match);
    const availabilityId = await createAvailability(
      payload,
      pipeline.id,
      pipeline.matchKind,
    );
    await notion(`/pages/${pipeline.id}`, "PATCH", {
      properties: { "Needs Full Availability": { checkbox: false } },
    });
    return Response.json({
      ok: true,
      pipelineAction: pipeline.created ? "created" : "updated",
      pipelineId: pipeline.id,
      availabilityId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("application: submission failed", message, payload.submissionId);
    if (message.startsWith("ambiguous_")) {
      return Response.json({ ok: false, error: "identity_conflict" }, { status: 409 });
    }
    return Response.json({ ok: false, error: "write_failed" }, { status: 500 });
  }
}
