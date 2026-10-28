import { authorizedRole } from "./interview-auth";
import { interviewDatabase } from "./interview-db";

export type InterviewerSettings = {
  email: string; displayName: string; active: boolean;
  campuses: Array<"BU" | "BC">; weeklyCapacity: number;
};
export function validateInterviewerSettings(input: unknown): InterviewerSettings {
  if (!input || typeof input !== "object") throw new Error("invalid_interviewer_settings");
  const value = input as InterviewerSettings;
  if (typeof value.email !== "string" || typeof value.displayName !== "string" ||
      !value.displayName.trim() || value.displayName.length > 100 ||
      typeof value.active !== "boolean" || !Array.isArray(value.campuses) ||
      value.campuses.length < 1 || value.campuses.length > 2 ||
      new Set(value.campuses).size !== value.campuses.length ||
      value.campuses.some(campus => campus !== "BU" && campus !== "BC") ||
      !Number.isInteger(value.weeklyCapacity) || value.weeklyCapacity < 0 || value.weeklyCapacity > 100 ||
      (value.active && value.weeklyCapacity === 0)) throw new Error("invalid_interviewer_settings");
  const email = value.email.trim().toLowerCase();
  // A dashboard setting cannot grant a new person sign-in permission.
  if (!authorizedRole(email)) throw new Error("interviewer_not_in_verified_allowlist");
  return {...value, email, displayName: value.displayName.trim()};
}
export async function saveInterviewerSettings(input: unknown, actor: string) {
  if (process.env.VERCEL_ENV !== "preview") throw new Error("interviewer_management_staging_only");
  const settings = validateInterviewerSettings(input);
  return interviewDatabase().begin(async tx => {
    const previous = await tx<{id:string}[]>`SELECT id FROM interview.interviewer WHERE lower(workspace_email)=${settings.email} FOR UPDATE`;
    const rows = await tx<{id:string}[]>`INSERT INTO interview.interviewer(workspace_email,display_name,active,allowed_campuses,weekly_capacity_limit)
      VALUES(${settings.email},${settings.displayName},${settings.active},${settings.campuses},${settings.weeklyCapacity})
      ON CONFLICT(lower(workspace_email)) DO UPDATE SET display_name=EXCLUDED.display_name,active=EXCLUDED.active,
        allowed_campuses=EXCLUDED.allowed_campuses,weekly_capacity_limit=EXCLUDED.weekly_capacity_limit,updated_at=now()
      RETURNING id`;
    const id = rows[0].id;
    const conflicts = await tx`UPDATE interview.reservation SET conflict_reason='interviewer_settings_changed',revision=revision+1,updated_at=now()
      WHERE interviewer_id=${id} AND starts_at>now() AND status NOT IN ('canceled','failed','expired')
        AND (${!settings.active} OR NOT (campus=ANY(${settings.campuses}::text[]))) RETURNING id`;
    await tx`INSERT INTO interview.audit_event(actor_ref,action,object_type,object_id,outcome,metadata)
      VALUES(${actor},'interviewer_settings','interviewer',${id},${previous.length?'updated':'created'},${tx.json({active:settings.active,campuses:settings.campuses,weeklyCapacity:settings.weeklyCapacity})})`;
    return {id, appointmentsRequiringReview:conflicts.length};
  });
}
