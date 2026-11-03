"use client";
import { useCallback, useState } from "react";
import FounderDashboard from "./founder-dashboard";
import SlotTimetable from "./slot-timetable";

type Applicant = { key: string; name: string; email: string; interviewStatus: string | null };

/** One campus filter shared by the applicant dashboard and the slot timetable. */
export default function FounderConsole() {
  const [campus, setCampus] = useState<"BU" | "BC" | "ALL">("ALL");
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [attendanceRevision, setAttendanceRevision] = useState(0);
  const handleApplicants = useCallback((rows: Applicant[]) => setApplicants(rows), []);
  return <>
    <FounderDashboard campus={campus} onCampus={setCampus} onApplicants={handleApplicants} attendanceRevision={attendanceRevision} />
    <SlotTimetable campus={campus} applicants={applicants} onAttendanceChanged={() => setAttendanceRevision(v => v + 1)} />
  </>;
}
