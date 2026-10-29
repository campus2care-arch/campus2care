import Link from "next/link";
import Image from "next/image";
import logo from "../../public/images/C2C-logo.png";
import InterviewBookingClient from "./booking-client";

/**
 * The custom scheduler's booking endpoints still accept only synthetic
 * staging applicants. Never render an unusable real-applicant booking UI
 * simply because the route was promoted to main.
 */
export default function StudentInterviewPage() {
  if (process.env.VERCEL_ENV === "preview" &&
      process.env.INTERVIEW_BOOKING_ENABLED === "true") {
    return <InterviewBookingClient />;
  }

  return (
    <main className="min-h-screen bg-[#f7f7f4] px-4 py-10 text-[#20201d] sm:px-8">
      <div className="mx-auto max-w-2xl">
        <header className="mb-10 flex items-center gap-3 border-b border-black/10 pb-6">
          <Link href="/" className="flex items-center gap-3">
            <Image src={logo} alt="Campus2Care" width={64} height={64} className="rounded-xl object-contain" />
            <div>
              <p className="text-xs font-bold uppercase tracking-[.16em] text-[#b3131b]">Campus2Care</p>
              <p className="text-lg font-black">Volunteer Interviews</p>
            </div>
          </Link>
        </header>
        <section className="rounded-2xl border border-black/10 bg-white p-8 shadow-sm">
          <p className="text-xs font-black uppercase tracking-widest text-[#b3131b]">Interview scheduling</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">Online interview booking is not open yet</h1>
          <p className="mt-4 leading-relaxed text-stone-700">
            Campus2Care is preparing its interview scheduling portal. Existing
            volunteer applications and scheduled appointments are unaffected.
            Please watch for an official invitation from Campus2Care when
            online booking becomes available.
          </p>
          <p className="mt-4 text-sm text-stone-500">
            If you already have a confirmed interview, follow the details in
            your calendar invitation.
          </p>
          <Link className="mt-6 inline-flex rounded-full border border-stone-300 px-5 py-3 text-sm font-semibold hover:bg-stone-100" href="/">Return to Campus2Care</Link>
        </section>
      </div>
    </main>
  );
}
