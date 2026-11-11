"use client";
import { useCallback, useState } from "react";
import FounderDashboard from "./founder-dashboard";
import SlotTimetable from "./slot-timetable";

type Applicant = { key: string; name: string; email: string; interviewStatus: string | null };

/**
 * One campus filter shared by the applicant dashboard and the slot timetable.
 * lockedCampus: chapter admins get the same console fixed to their chapter. The server
 * enforces that scope independently; this only keeps the controls honest.
 */
export default function FounderConsole({ lockedCampus }: { lockedCampus?: "BU" | "BC" } = {}) {
  const [campus, setCampus] = useState<"BU" | "BC" | "ALL">(lockedCampus ?? "ALL");
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [attendanceRevision, setAttendanceRevision] = useState(0);
  const handleApplicants = useCallback((rows: Applicant[]) => setApplicants(rows), []);
  const scope = lockedCampus ?? campus;
  return <>
    <FounderDashboard campus={scope} onCampus={lockedCampus ? () => undefined : setCampus} lockedCampus={lockedCampus}
      onApplicants={handleApplicants} attendanceRevision={attendanceRevision} />
    <SlotTimetable campus={scope} applicants={applicants} canManageSlots={!lockedCampus}
      onAttendanceChanged={() => setAttendanceRevision(v => v + 1)} />
  </>;
}
