import type { ChapterCampus, StaffIdentity } from "./interview-auth";
import type { RosterMember } from "./interview-staff-db";

export const FOUNDER_EMAIL = "president@campus2care.org";

/** Founder = the founder account holding the admin role. Founder-only security and system controls stay here. */
export function isFounder(staff: StaffIdentity | null | undefined): boolean {
  return staff?.role === "admin" && staff.email === FOUNDER_EMAIL;
}

/** Chapter admins (Chapter Admin / Interview Team Manager) share the founder's scheduling view for one campus. */
export function chapterOf(staff: StaffIdentity | null | undefined): ChapterCampus | null {
  return staff?.role === "chapter_admin" && (staff.campus === "BU" || staff.campus === "BC") ? staff.campus : null;
}

/** Founder or chapter admin: who may open the shared scheduling dashboard at all. */
export function canUseSchedulingDashboard(staff: StaffIdentity | null | undefined): boolean {
  return isFounder(staff) || chapterOf(staff) !== null;
}

/**
 * A live chapter admin: reads cover the whole chapter; writes cover only their own team
 * (themselves as lead plus the shadowers assigned to them). leadId is their interviewer row.
 */
export type ChapterContext = { campus: ChapterCampus; email: string; leadId: string };

/**
 * The registry alone is not enough: a chapter admin is live only while still an active lead of
 * exactly their chapter on the interviewer roster. Removing them from the roster, or changing
 * their campus or role, revokes the chapter dashboard on the next request.
 */
export async function chapterContext(staff: StaffIdentity | null | undefined,
  lookup: (email: string) => Promise<RosterMember | null>): Promise<ChapterContext | null> {
  const campus = chapterOf(staff);
  if (!campus || !staff) return null;
  const member = await lookup(staff.email);
  if (!member || member.teamRole !== "lead" || member.campuses.length !== 1 || member.campuses[0] !== campus) return null;
  return { campus, email: staff.email, leadId: member.id };
}

/**
 * Resolve the campus a request may read. The server decides; the browser filter is only a hint.
 * - founder: BU, BC or ALL as requested (default ALL)
 * - chapter admin: own campus only; a missing value defaults to it, anything else is refused
 * Returns null when the request is not allowed.
 */
export function scopedCampus(staff: StaffIdentity | null | undefined,
  requested: string | null | undefined): ChapterCampus | "ALL" | null {
  if (isFounder(staff)) {
    const value = requested ?? "ALL";
    return value === "BU" || value === "BC" || value === "ALL" ? value : null;
  }
  const own = chapterOf(staff);
  if (!own) return null;
  return requested === null || requested === undefined || requested === "" || requested === own ? own : null;
}
