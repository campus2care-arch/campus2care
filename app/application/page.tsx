"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const START_MIN = 7 * 60;
const END_MIN = 22 * 60;
const STEP = 30;
const ROWS = (END_MIN - START_MIN) / STEP;

type Cell = { d: number; r: number };
type Answers = {
  fullName: string;
  email: string;
  alternateEmail: string;
  phone: string;
  school: string;
  graduationYear: string;
  major: string;
  clinicalCertification: string;
  priorClinicalExperience: string;
  comfortableWithPatients: string;
  preferredStartDate: string;
  weeklyCommitmentHours: string;
  motivation: string;
  referralSource: string;
  availabilityNotes: string;
};

const EMPTY_ANSWERS: Answers = {
  fullName: "",
  email: "",
  alternateEmail: "",
  phone: "",
  school: "",
  graduationYear: "",
  major: "",
  clinicalCertification: "",
  priorClinicalExperience: "",
  comfortableWithPatients: "",
  preferredStartDate: "",
  weeklyCommitmentHours: "",
  motivation: "",
  referralSource: "",
  availabilityNotes: "",
};

function emptyGrid() {
  return Array.from({ length: 7 }, () => Array<boolean>(ROWS).fill(false));
}

function fmt(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h >= 12 ? "pm" : "am"}`;
}

function blocksFor(col: boolean[]) {
  const blocks: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (let r = 0; r <= ROWS; r++) {
    const selected = r < ROWS && col[r];
    if (selected && start === null) start = r;
    if (!selected && start !== null) {
      blocks.push({
        start: START_MIN + start * STEP,
        end: START_MIN + r * STEP,
      });
      start = null;
    }
  }
  return blocks;
}

function Field({
  label,
  required,
  children,
  full = false,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={full ? "sm:col-span-2" : ""}>
      <span className="mb-1.5 block text-sm font-bold">
        {label} {required && <span className="text-[#b3131b]">*</span>}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "min-h-12 w-full rounded-xl border border-[#d6d6d1] bg-white px-3.5 py-2.5 outline-none transition focus:border-[#b3131b] focus:ring-3 focus:ring-[#b3131b]/10";

export default function ApplicationPage() {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [grid, setGrid] = useState<boolean[][]>(emptyGrid);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const submissionId = useRef("");
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { select: boolean; lastDay: number; lastRow: number }
    | null
  >(null);

  const update = (key: keyof Answers, value: string) =>
    setAnswers((current) => ({ ...current, [key]: value }));

  const paint = useCallback((cell: Cell, select: boolean) => {
    setGrid((current) => {
      if (current[cell.d][cell.r] === select) return current;
      const next = current.map((day) => day.slice());
      next[cell.d][cell.r] = select;
      return next;
    });
  }, []);

  const paintPath = useCallback(
    (to: Cell) => {
      const active = drag.current;
      if (!active) return;
      const distance = Math.max(
        Math.abs(to.d - active.lastDay),
        Math.abs(to.r - active.lastRow),
        1,
      );
      for (let i = 1; i <= distance; i++) {
        paint(
          {
            d: Math.round(active.lastDay + ((to.d - active.lastDay) * i) / distance),
            r: Math.round(active.lastRow + ((to.r - active.lastRow) * i) / distance),
          },
          active.select,
        );
      }
      active.lastDay = to.d;
      active.lastRow = to.r;
    },
    [paint],
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      const element = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-availability-cell]");
      if (!element || !gridRef.current?.contains(element)) return;
      paintPath({ d: Number(element.dataset.d), r: Number(element.dataset.r) });
    };
    const end = () => {
      drag.current = null;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
    };
  }, [paintPath]);

  const stats = useMemo(() => {
    let slots = 0;
    let longestWeekday = 0;
    grid.forEach((day, index) => {
      slots += day.filter(Boolean).length;
      if (index < 5) {
        blocksFor(day).forEach((block) => {
          longestWeekday = Math.max(longestWeekday, block.end - block.start);
        });
      }
    });
    return {
      totalHours: (slots * STEP) / 60,
      longestWeekdayHours: longestWeekday / 60,
      meetsWeekdayBlock: longestWeekday >= 180,
    };
  }, [grid]);

  function preset(kind: "morning" | "afternoon" | "clear") {
    const next = emptyGrid();
    if (kind !== "clear") {
      const from = kind === "morning" ? 9 * 60 : 13 * 60;
      const to = kind === "morning" ? 12 * 60 : 17 * 60;
      for (let d = 0; d < 5; d++) {
        for (let r = 0; r < ROWS; r++) {
          const min = START_MIN + r * STEP;
          if (min >= from && min < to) next[d][r] = true;
        }
      }
    }
    setGrid(next);
  }

  function validate(current: number) {
    setError("");
    if (current === 0) {
      if (
        !answers.fullName.trim() ||
        !answers.school.trim() ||
        !answers.major.trim() ||
        !answers.graduationYear
      ) {
        setError("Please complete each required field.");
        return false;
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(answers.email.trim())) {
        setError("Please enter a valid email address.");
        return false;
      }
      if (
        answers.alternateEmail &&
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(answers.alternateEmail.trim())
      ) {
        setError("Please check the other email address.");
        return false;
      }
    }
    if (current === 1) {
      if (
        !answers.clinicalCertification ||
        !answers.priorClinicalExperience ||
        !answers.comfortableWithPatients ||
        !answers.preferredStartDate ||
        !answers.weeklyCommitmentHours ||
        !answers.motivation.trim() ||
        !answers.referralSource.trim()
      ) {
        setError("Please complete each required field.");
        return false;
      }
    }
    if (current === 2 && stats.totalHours === 0) {
      setError("Please add at least one time when you are available.");
      return false;
    }
    return true;
  }

  function go(next: number) {
    if (next > step && !validate(step)) return;
    setError("");
    setStep(Math.max(0, Math.min(3, next)));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const availabilityByDay = useMemo(() => {
    const output: Record<string, string> = {};
    DAYS.forEach((day, d) => {
      const blocks = blocksFor(grid[d]);
      output[day] = blocks.length
        ? blocks.map((block) => `${fmt(block.start)}–${fmt(block.end)}`).join(", ")
        : "Unavailable";
    });
    return output;
  }, [grid]);

  async function submit() {
    if (!validate(3)) return;
    if (!submissionId.current) submissionId.current = crypto.randomUUID();
    setSending(true);
    try {
      const response = await fetch("/api/application", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId: submissionId.current,
          ...answers,
          graduationYear: Number(answers.graduationYear),
          weeklyCommitmentHours: Number(answers.weeklyCommitmentHours),
          totalHours: stats.totalHours,
          longestWeekdayBlockHours: stats.longestWeekdayHours,
          meetsWeekdayBlock: stats.meetsWeekdayBlock,
          availabilityByDay,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (result.error === "identity_conflict") {
          throw new Error("identity_conflict");
        }
        throw new Error("submit_failed");
      }
      setDone(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (submitError) {
      setSending(false);
      setError(
        submitError instanceof Error && submitError.message === "identity_conflict"
          ? "We found more than one possible existing profile. Please email campus2care@gmail.com so we can connect your application safely."
          : "Your application was not saved. Please try again, or email campus2care@gmail.com.",
      );
    }
  }

  if (done) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f7f4] px-6 text-center">
        <div className="max-w-lg rounded-3xl border border-black/10 bg-white p-10 shadow-[0_20px_60px_rgba(0,0,0,.08)]">
          <Image src="/images/C2C-logo.png" alt="Campus2Care" width={64} height={64} className="mx-auto h-16 w-16 rounded-full" />
          <h1 className="mt-5 text-3xl font-black tracking-tight">Application submitted.</h1>
          <p className="mt-3 leading-relaxed text-[#60605c]">
            Thank you. Campus2Care will review your application and contact you about next steps.
          </p>
          <Link href="/" className="mt-7 inline-flex rounded-full bg-[#b3131b] px-6 py-3 font-bold text-white hover:bg-[#920f16]">
            Return to Campus2Care
          </Link>
        </div>
      </main>
    );
  }

  const choice = (
    key: keyof Answers,
    label: string,
  ) => (
    <fieldset>
      <legend className="mb-2 text-sm font-bold">
        {label} <span className="text-[#b3131b]">*</span>
      </legend>
      <div className="flex gap-2">
        {["Yes", "No"].map((value) => (
          <label key={value} className="cursor-pointer">
            <input
              type="radio"
              name={key}
              value={value}
              checked={answers[key] === value}
              onChange={(event) => update(key, event.target.value)}
              className="peer sr-only"
            />
            <span className="block min-w-24 rounded-xl border border-[#d6d6d1] px-4 py-2.5 text-center font-bold peer-checked:border-[#b3131b] peer-checked:bg-[#fff1f1] peer-checked:text-[#920f16]">
              {value}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <main className="min-h-screen bg-[#f7f7f4] text-[#181818]">
      <header className="sticky top-0 z-50 border-b border-white/15 bg-[#b3131b] text-white shadow-sm">
        <Link href="/" className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
          <Image src="/images/C2C-logo.png" alt="Campus2Care logo" width={40} height={40} className="h-10 w-10 rounded-full bg-white" />
          <span className="text-xl font-black tracking-tight">Campus2Care</span>
        </Link>
      </header>

      <div className="mx-auto grid max-w-6xl gap-5 px-3 py-5 md:grid-cols-[230px_minmax(0,1fr)] md:px-6 md:py-9">
        <aside className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm md:sticky md:top-24 md:self-start md:p-5">
          <p className="text-xs font-black uppercase tracking-[.16em] text-[#b3131b]">Volunteer application</p>
          <h1 className="mt-2 hidden text-xl font-black leading-tight tracking-tight md:block">One simple application.</h1>
          <ol className="mt-4 grid grid-cols-4 gap-1 md:grid-cols-1 md:gap-2">
            {["About you", "Experience", "Availability", "Review"].map((label, index) => (
              <li key={label}>
                <button
                  type="button"
                  onClick={() => index <= step && go(index)}
                  className={`flex w-full flex-col items-center gap-1 rounded-xl p-2 text-xs font-bold md:flex-row md:gap-3 md:text-sm ${
                    index === step ? "bg-[#fff1f1] text-[#920f16]" : "text-[#6a6a66]"
                  }`}
                >
                  <span className={`grid h-8 w-8 place-items-center rounded-full border ${index <= step ? "border-[#b3131b] bg-[#b3131b] text-white" : "border-[#d6d6d1]"}`}>
                    {index + 1}
                  </span>
                  <span>{label}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[#ecece8]">
            <div className="h-full bg-[#b3131b] transition-all" style={{ width: `${(step + 1) * 25}%` }} />
          </div>
        </aside>

        <section className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm sm:p-8 md:p-10">
          {step === 0 && (
            <>
              <p className="text-xs font-black uppercase tracking-[.16em] text-[#b3131b]">Step 1 of 4</p>
              <h2 className="mt-2 text-3xl font-black tracking-[-.04em] sm:text-4xl">Tell us about yourself.</h2>
              <p className="mt-2 text-[#62625e]">Use the email you want us to use throughout the interview and placement process.</p>
              <div className="mt-8 grid gap-5 sm:grid-cols-2">
                <Field label="Full name" required><input className={inputClass} autoComplete="name" value={answers.fullName} onChange={(e) => update("fullName", e.target.value)} /></Field>
                <Field label="Email" required><input className={inputClass} type="email" autoComplete="email" placeholder="you@bu.edu" value={answers.email} onChange={(e) => update("email", e.target.value)} /></Field>
                <Field label="Other email"><input className={inputClass} type="email" placeholder="Optional" value={answers.alternateEmail} onChange={(e) => update("alternateEmail", e.target.value)} /></Field>
                <Field label="Phone number"><input className={inputClass} type="tel" autoComplete="tel" placeholder="Optional" value={answers.phone} onChange={(e) => update("phone", e.target.value)} /></Field>
                <Field label="University or college" required><input className={inputClass} value={answers.school} onChange={(e) => update("school", e.target.value)} /></Field>
                <Field label="Graduation year" required><input className={inputClass} type="number" min="2024" max="2040" value={answers.graduationYear} onChange={(e) => update("graduationYear", e.target.value)} /></Field>
                <Field label="Major" required full><input className={inputClass} value={answers.major} onChange={(e) => update("major", e.target.value)} /></Field>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-xs font-black uppercase tracking-[.16em] text-[#b3131b]">Step 2 of 4</p>
              <h2 className="mt-2 text-3xl font-black tracking-[-.04em] sm:text-4xl">Your readiness and goals.</h2>
              <p className="mt-2 text-[#62625e]">Certifications and prior experience are helpful, but they are not required.</p>
              <div className="mt-8 grid gap-7 sm:grid-cols-2">
                {choice("clinicalCertification", "Do you have a clinical certification?")}
                {choice("priorClinicalExperience", "Do you have prior clinical volunteer experience?")}
                <div className="sm:col-span-2">{choice("comfortableWithPatients", "Would you be comfortable interacting with patients after training?")}</div>
                <Field label="Preferred start date" required><input className={inputClass} type="date" value={answers.preferredStartDate} onChange={(e) => update("preferredStartDate", e.target.value)} /></Field>
                <Field label="Hours per week you can commit" required><input className={inputClass} type="number" min="1" max="40" value={answers.weeklyCommitmentHours} onChange={(e) => update("weeklyCommitmentHours", e.target.value)} /></Field>
                <Field label="Why are you interested in becoming a clinical advocate?" required full><textarea className={`${inputClass} min-h-32 resize-y`} value={answers.motivation} onChange={(e) => update("motivation", e.target.value)} /></Field>
                <Field label="How did you hear about Campus2Care?" required full><input className={inputClass} value={answers.referralSource} onChange={(e) => update("referralSource", e.target.value)} /></Field>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-xs font-black uppercase tracking-[.16em] text-[#b3131b]">Step 3 of 4</p>
              <h2 className="mt-2 text-3xl font-black tracking-[-.04em] sm:text-4xl">When can you volunteer?</h2>
              <p className="mt-2 text-[#62625e]">Click and drag across the calendar. Dragging over selected time removes it. Anything blank counts as unavailable.</p>
              <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl bg-[#f7f7f4] p-3">
                <span className="mr-auto text-sm text-[#62625e]">Most sites need one consistent weekday block of at least 3 hours.</span>
                {(["morning", "afternoon", "clear"] as const).map((kind) => (
                  <button key={kind} type="button" onClick={() => preset(kind)} className="rounded-full border border-[#d6d6d1] bg-white px-3 py-1.5 text-sm font-bold hover:border-[#b3131b] hover:text-[#b3131b]">
                    {kind === "morning" ? "Weekday mornings" : kind === "afternoon" ? "Weekday afternoons" : "Clear all"}
                  </button>
                ))}
              </div>
              <div ref={gridRef} className="mt-4 overflow-x-auto rounded-xl border border-[#dededa] bg-white">
                <table className="w-full min-w-[650px] table-fixed border-collapse select-none">
                  <thead><tr><th className="w-16 bg-[#fafaf8]" />{DAY_SHORT.map((day, d) => <th key={day} className="border-b border-l border-[#e7e7e2] bg-[#fafaf8] py-3 text-xs font-black">{day}{grid[d].some(Boolean) && <button type="button" aria-label={`Clear ${DAYS[d]}`} onClick={() => setGrid((current) => current.map((col, i) => i === d ? Array<boolean>(ROWS).fill(false) : col))} className="ml-1 rounded-full px-1 text-[#85857f] hover:bg-[#b3131b] hover:text-white">×</button>}</th>)}</tr></thead>
                  <tbody>
                    {Array.from({ length: ROWS }, (_, r) => {
                      const min = START_MIN + r * STEP;
                      return <tr key={r}><td className={`border-r border-[#e7e7e2] pr-2 text-right align-top text-[11px] ${min % 60 === 0 ? "font-bold text-[#444]" : "text-transparent"}`}>{min % 60 === 0 ? fmt(min) : "."}</td>{DAYS.map((_, d) => <td key={d} data-availability-cell data-d={d} data-r={r} onPointerDown={(event) => { event.preventDefault(); const select = !grid[d][r]; drag.current = { select, lastDay: d, lastRow: r }; paint({ d, r }, select); }} className={`h-[20px] touch-none cursor-pointer border-r border-[#f0f0ed] ${r % 2 === 1 ? "border-b border-b-[#dededa]" : "border-b border-b-[#f4f4f1]"} ${grid[d][r] ? "bg-[#b3131b]" : "bg-white hover:bg-[#fff0f0]"}`} />)}</tr>;
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex flex-col gap-3 rounded-xl bg-[#181818] p-4 text-white sm:flex-row sm:items-center sm:justify-between">
                <div><b className="text-xl">{stats.totalHours} hours selected</b><p className="text-xs text-white/65">Calculated from the weekly calendar.</p></div>
                <span className="rounded-full border border-white/20 px-3 py-1.5 text-sm font-bold">{stats.meetsWeekdayBlock ? "3-hour weekday block available" : "No 3-hour weekday block yet"}</span>
              </div>
              <div className="mt-5"><Field label="Schedule notes"><textarea className={`${inputClass} min-h-24 resize-y`} placeholder="Class schedule changes, transportation limits, or other details" value={answers.availabilityNotes} onChange={(e) => update("availabilityNotes", e.target.value)} /></Field></div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="text-xs font-black uppercase tracking-[.16em] text-[#b3131b]">Step 4 of 4</p>
              <h2 className="mt-2 text-3xl font-black tracking-[-.04em] sm:text-4xl">Review your application.</h2>
              <p className="mt-2 text-[#62625e]">Check the details below, then submit when everything looks right.</p>
              <div className="mt-8 grid gap-4">
                <ReviewCard title="About you" rows={[["Name", answers.fullName], ["Email", answers.email], ["School", answers.school], ["Graduation", answers.graduationYear], ["Major", answers.major]]} />
                <ReviewCard title="Readiness and goals" rows={[["Certification", answers.clinicalCertification], ["Prior experience", answers.priorClinicalExperience], ["Patient interaction", answers.comfortableWithPatients], ["Preferred start", answers.preferredStartDate], ["Weekly commitment", `${answers.weeklyCommitmentHours} hours`], ["Motivation", answers.motivation], ["Referral", answers.referralSource]]} />
                <ReviewCard title="Weekly availability" rows={[...DAYS.map((day) => [day, availabilityByDay[day]]), ["Calculated total", `${stats.totalHours} hours`], ["Weekday block", stats.meetsWeekdayBlock ? "At least one 3-hour block" : "No 3-hour block"]]} />
              </div>
            </>
          )}

          {error && <div role="alert" className="mt-6 rounded-xl bg-[#fff0f0] px-4 py-3 text-sm font-semibold text-[#850000]">{error}</div>}
          <div className="mt-8 flex items-center justify-between gap-3">
            {step > 0 ? <button type="button" onClick={() => go(step - 1)} className="rounded-full border border-[#d6d6d1] px-5 py-2.5 font-bold hover:bg-[#f4f4f1]">Back</button> : <span />}
            {step < 3 ? <button type="button" onClick={() => go(step + 1)} className="rounded-full bg-[#b3131b] px-6 py-3 font-bold text-white hover:bg-[#920f16]">Continue</button> : <button type="button" onClick={submit} disabled={sending} className="rounded-full bg-[#b3131b] px-7 py-3 font-bold text-white hover:bg-[#920f16] disabled:cursor-wait disabled:bg-[#aaa]">{sending ? "Submitting…" : "Submit application"}</button>}
          </div>
        </section>
      </div>
    </main>
  );
}

function ReviewCard({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <section className="rounded-xl border border-[#dededa] p-5">
      <h3 className="font-black">{title}</h3>
      <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[145px_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents"><dt className="text-[#70706b]">{label}</dt><dd className="m-0 break-words font-semibold">{value || "Not provided"}</dd></div>
        ))}
      </dl>
    </section>
  );
}
