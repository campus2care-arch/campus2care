"use client";

import Image, { type StaticImageData } from "next/image";
import { useEffect, useRef, useState } from "react";

type DonationJourneyProps = {
  donateLink: string;
  logo: StaticImageData;
};

const missionChoices = [
  {
    id: "prepare",
    label: "Prepare students",
    short: "Workshops and readiness",
    message:
      "prepare students to enter hospital service with stronger expectations, communication skills, and respect for their role.",
  },
  {
    id: "guide",
    label: "Guide the journey",
    short: "Mentorship and check-ins",
    message:
      "guide students through a demanding process with mentorship, check-ins, and a community behind them.",
  },
  {
    id: "grow",
    label: "Grow access",
    short: "Resources and infrastructure",
    message:
      "build the resources and infrastructure that help Campus2Care support more students and hospital pathways.",
  },
];

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path
        d="M4 10h12m-5-5 5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="m5 12.5 4.2 4.2L19 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function DonationJourney({
  donateLink,
  logo,
}: DonationJourneyProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [mission, setMission] = useState(missionChoices[0]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);

      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  const openJourney = () => {
    setStep(0);
    setIsOpen(true);
  };

  return (
    <section
      id="donate"
      className="section-anchor overflow-hidden bg-white py-20 sm:py-28"
    >
      <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
        <div
          className="donation-stage relative overflow-hidden rounded-[2rem] bg-[#a70f17] text-white sm:rounded-[2.75rem]"
          data-reveal="scale"
        >
          <div className="donation-grid" aria-hidden="true" />
          <div className="donation-glow donation-glow-one" aria-hidden="true" />
          <div className="donation-glow donation-glow-two" aria-hidden="true" />

          <div className="relative z-10 grid min-h-[680px] lg:grid-cols-[1.08fr_0.92fr]">
            <div className="flex flex-col justify-between p-7 sm:p-12 lg:p-16">
              <div className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.18em] text-white/70">
                <span className="h-px w-8 bg-white/45" />
                Support Campus2Care
              </div>

              <div className="my-16 max-w-[760px] lg:my-20">
                <h2 className="text-[clamp(3.3rem,7vw,7rem)] font-black leading-[0.87] tracking-[-0.07em]">
                  Help the next student show up ready.
                </h2>
                <p className="mt-7 max-w-2xl text-lg leading-8 text-white/76 sm:text-xl sm:leading-9">
                  Your support strengthens the preparation, mentorship, and
                  resources that help students navigate hospital volunteer
                  pathways with purpose.
                </p>
                <button
                  type="button"
                  onClick={openJourney}
                  className="donation-start mt-9"
                >
                  Start your impact <ArrowIcon />
                </button>
                <p className="mt-4 text-sm text-white/58">
                  Explore your impact, then continue to secure checkout.
                </p>
              </div>

              <div className="grid gap-3 border-t border-white/18 pt-6 sm:grid-cols-3">
                {[
                  ["01", "Prepare", "Student workshops"],
                  ["02", "Guide", "Mentorship and check-ins"],
                  ["03", "Grow", "Program resources"],
                ].map(([number, title, description]) => (
                  <div key={number} className="donation-pillar">
                    <span>{number}</span>
                    <div>
                      <strong>{title}</strong>
                      <p>{description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="donation-visual relative flex min-h-[460px] items-center justify-center px-6 py-14 lg:min-h-full">
              <div className="donation-orbit donation-orbit-outer" aria-hidden="true" />
              <div className="donation-orbit donation-orbit-inner" aria-hidden="true" />
              <div className="donation-logo-wrap">
                <div className="donation-logo-halo" aria-hidden="true" />
                <Image
                  src={logo}
                  alt="Campus2Care"
                  className="relative z-10 h-44 w-44 rounded-full object-cover sm:h-56 sm:w-56"
                />
              </div>
              <span className="donation-orbit-label orbit-label-one">Preparation</span>
              <span className="donation-orbit-label orbit-label-two">Mentorship</span>
              <span className="donation-orbit-label orbit-label-three">Access</span>
            </div>
          </div>
        </div>

        <div className="mt-7 flex flex-col gap-3 px-1 text-sm leading-6 text-[#6a6a64] lg:flex-row lg:items-start lg:justify-between">
          <p className="max-w-3xl">
            Campus2Care is a registered 501(c)(3) nonprofit organization, EIN
            41-5148269. Contributions are tax-deductible to the extent allowed
            by law.
          </p>
          <p className="shrink-0 font-semibold text-[#3e3e3a]">
            Payments are processed securely through Stripe.
          </p>
        </div>
      </div>

      {isOpen && (
        <div
          ref={dialogRef}
          className="donation-modal fixed inset-0 z-[100] flex overflow-y-auto bg-[#850b12]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="donation-dialog-title"
        >
          <div className="donation-modal-grid" aria-hidden="true" />
          <div className="donation-modal-glow" aria-hidden="true" />

          <div className="relative z-10 mx-auto flex min-h-full w-full max-w-[1280px] flex-col px-5 py-5 text-white sm:px-8 sm:py-8 lg:px-12">
            <div className="flex items-center justify-between gap-5">
              <div className="flex items-center gap-3">
                <Image
                  src={logo}
                  alt=""
                  className="h-10 w-10 rounded-full object-cover ring-1 ring-white/25"
                />
                <span className="font-black tracking-[-0.02em]">Campus2Care</span>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setIsOpen(false)}
                className="donation-close"
                aria-label="Close donation journey"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <div className="mt-8 flex items-center gap-4 sm:mt-12">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/60">
                Step {step + 1} of 3
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/14">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-500 ease-out"
                  style={{ width: `${((step + 1) / 3) * 100}%` }}
                />
              </div>
            </div>

            <div className="flex flex-1 items-center py-10 sm:py-14">
              {step === 0 && (
                <div className="w-full donation-step-enter">
                  <p className="text-sm font-black uppercase tracking-[0.18em] text-[#ffb7bb]">
                    You are about to move care forward
                  </p>
                  <h2
                    id="donation-dialog-title"
                    className="mt-5 max-w-5xl text-[clamp(3rem,7vw,6.8rem)] font-black leading-[0.9] tracking-[-0.065em]"
                  >
                    What part of the mission speaks to you?
                  </h2>
                  <p className="mt-6 max-w-2xl text-lg leading-8 text-white/70">
                    Choose a focus to see how your support fits into the larger
                    Campus2Care journey. Your donation supports our overall work.
                  </p>

                  <div className="mt-10 grid gap-3 lg:grid-cols-3">
                    {missionChoices.map((choice, index) => {
                      const selected = mission.id === choice.id;
                      return (
                        <button
                          key={choice.id}
                          type="button"
                          onClick={() => setMission(choice)}
                          className={`mission-choice ${selected ? "is-selected" : ""}`}
                          aria-pressed={selected}
                        >
                          <span className="mission-choice-number">0{index + 1}</span>
                          <strong>{choice.label}</strong>
                          <span>{choice.short}</span>
                          <span className="mission-choice-check">
                            <CheckIcon />
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="donation-next mt-8"
                  >
                    See your impact <ArrowIcon />
                  </button>
                </div>
              )}

              {step === 1 && (
                <div className="grid w-full gap-10 donation-step-enter lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:gap-20">
                  <div>
                    <p className="text-sm font-black uppercase tracking-[0.18em] text-[#ffb7bb]">
                      Your support has momentum
                    </p>
                    <h2
                      id="donation-dialog-title"
                      className="mt-5 text-[clamp(3rem,6vw,6rem)] font-black leading-[0.91] tracking-[-0.065em]"
                    >
                      You can help us {mission.message}
                    </h2>
                    <p className="mt-7 max-w-2xl text-lg leading-8 text-white/70">
                      Every gift joins a larger system of preparation and support.
                      It is not just a transaction. It helps Campus2Care keep the
                      path organized, personal, and sustainable.
                    </p>
                    <div className="mt-9 flex flex-wrap gap-3">
                      <button
                        type="button"
                        onClick={() => setStep(0)}
                        className="donation-back"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={() => setStep(2)}
                        className="donation-next"
                      >
                        Continue <ArrowIcon />
                      </button>
                    </div>
                  </div>

                  <div className="impact-visual" aria-label="Campus2Care impact pathway">
                    <div className="impact-line" aria-hidden="true" />
                    {[
                      ["Prepare", "Clear expectations before service"],
                      ["Support", "Mentorship throughout the process"],
                      ["Sustain", "Resources for a growing program"],
                    ].map(([title, description], index) => (
                      <div key={title} className="impact-point">
                        <span>{index + 1}</span>
                        <div>
                          <strong>{title}</strong>
                          <p>{description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="mx-auto w-full max-w-4xl text-center donation-step-enter">
                  <div className="donation-final-mark">
                    <Image
                      src={logo}
                      alt="Campus2Care"
                      className="h-28 w-28 rounded-full object-cover sm:h-36 sm:w-36"
                    />
                  </div>
                  <p className="mt-8 text-sm font-black uppercase tracking-[0.18em] text-[#ffb7bb]">
                    One final step
                  </p>
                  <h2
                    id="donation-dialog-title"
                    className="mt-5 text-[clamp(3.2rem,7vw,6.8rem)] font-black leading-[0.88] tracking-[-0.07em]"
                  >
                    You&apos;re ready to make it real.
                  </h2>
                  <p className="mx-auto mt-7 max-w-2xl text-lg leading-8 text-white/72">
                    Continue to Stripe to choose your amount and complete your
                    tax-deductible donation securely.
                  </p>
                  <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="donation-back"
                    >
                      Back
                    </button>
                    <a
                      href={donateLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="donation-finish"
                    >
                      Continue to secure donation <ArrowIcon />
                    </a>
                  </div>
                  <div className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 text-sm font-semibold text-white/62">
                    <span className="inline-flex items-center gap-2">
                      <CheckIcon /> Stripe-secured payment
                    </span>
                    <span className="inline-flex items-center gap-2">
                      <CheckIcon /> Campus2Care stores no payment data
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
