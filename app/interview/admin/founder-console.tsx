"use client";
import { useState } from "react";
import FounderDashboard from "./founder-dashboard";
import SlotTimetable from "./slot-timetable";

/** One campus filter shared by the applicant dashboard and the slot timetable. */
export default function FounderConsole() {
  const [campus, setCampus] = useState<"BU" | "BC" | "ALL">("ALL");
  return <>
    <FounderDashboard campus={campus} onCampus={setCampus} />
    <SlotTimetable campus={campus} />
  </>;
}
