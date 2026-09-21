"use client";

import Image, { type StaticImageData } from "next/image";
import { useEffect, useState } from "react";

import workshopOpening from "../public/images/events/hero-sept13-workshop.webp";
import workshopRoom from "../public/images/events/hero-sept13-room.webp";
import workshopCommunity from "../public/images/events/hero-sept13-community.webp";
import workshopFacilitators from "../public/images/events/hero-sept13-facilitators.webp";

const slides: Array<{
  image: StaticImageData;
  alt: string;
  label: string;
  description: string;
  position?: string;
}> = [
  {
    image: workshopOpening,
    alt: "Campus2Care leadership working with a full room of students at the September 13 workshop",
    label: "September 13 student workshop",
    description: "Students preparing together for hospital service.",
  },
  {
    image: workshopRoom,
    alt: "Andrew Makar supporting a packed room of students during the September 13 Campus2Care workshop",
    label: "A full room, ready to serve",
    description: "Campus2Care leadership guiding students through program onboarding.",
  },
  {
    image: workshopCommunity,
    alt: "Campus2Care leaders and students working together during the September 13 workshop",
    label: "Community in motion",
    description: "Students and leaders working through the process side by side.",
  },
  {
    image: workshopFacilitators,
    alt: "Campus2Care facilitators helping students during the September 13 workshop",
    label: "Preparation that feels personal",
    description: "Hands-on support before students begin hospital service.",
    position: "object-[54%_center]",
  },
];

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="h-4 w-4">
      <path
        d={direction === "left" ? "m12 5-5 5 5 5" : "m8 5 5 5-5 5"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PauseIcon({ paused }: { paused: boolean }) {
  return paused ? (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="m7 5 8 5-8 5V5Z" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <rect x="6" y="5" width="3" height="10" rx="1" />
      <rect x="11" y="5" width="3" height="10" rx="1" />
    </svg>
  );
}

export default function HeroCarousel() {
  const [activeSlide, setActiveSlide] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(mediaQuery.matches);

    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    if (paused || hovered || reducedMotion) {
      return;
    }

    const timer = window.setTimeout(() => {
      setActiveSlide((current) => (current + 1) % slides.length);
    }, 5200);

    return () => window.clearTimeout(timer);
  }, [activeSlide, hovered, paused, reducedMotion]);

  const showPrevious = () => {
    setActiveSlide((current) => (current - 1 + slides.length) % slides.length);
  };

  const showNext = () => {
    setActiveSlide((current) => (current + 1) % slides.length);
  };

  return (
    <div
      className="hero-frame group relative aspect-[4/3] overflow-hidden rounded-[2rem] bg-[#deded8]"
      role="region"
      aria-roledescription="carousel"
      aria-label="September 13 Campus2Care workshop photos"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {slides.map((slide, index) => {
        const isActive = index === activeSlide;

        return (
          <Image
            key={slide.image.src}
            src={slide.image}
            alt={isActive ? slide.alt : ""}
            aria-hidden={!isActive}
            fill
            priority={index === 0}
            sizes="(max-width: 1024px) 100vw, 52vw"
            className={`object-cover transition-[opacity,transform] duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)] ${
              slide.position ?? "object-center"
            } ${isActive ? "scale-100 opacity-100" : "pointer-events-none scale-[1.015] opacity-0"}`}
          />
        );
      })}

      <div className="absolute inset-x-4 bottom-4 flex items-end justify-between gap-4 rounded-[1.25rem] border border-white/15 bg-black/58 px-5 py-4 text-white shadow-[0_18px_50px_rgba(0,0,0,0.22)] backdrop-blur-md sm:inset-x-5 sm:bottom-5 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/70">
            {slides[activeSlide].label}
          </p>
          <p className="mt-1.5 max-w-xl text-base font-semibold leading-6 sm:text-xl sm:leading-7">
            {slides[activeSlide].description}
          </p>
        </div>

        <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-white/8 transition hover:bg-white/18 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            onClick={showPrevious}
            aria-label="Show previous workshop photo"
          >
            <Chevron direction="left" />
          </button>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-white/8 transition hover:bg-white/18 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            onClick={() => setPaused((current) => !current)}
            aria-label={paused ? "Resume workshop slideshow" : "Pause workshop slideshow"}
          >
            <PauseIcon paused={paused} />
          </button>
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-white/8 transition hover:bg-white/18 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            onClick={showNext}
            aria-label="Show next workshop photo"
          >
            <Chevron direction="right" />
          </button>
        </div>
      </div>

      <div className="absolute left-1/2 top-5 flex -translate-x-1/2 gap-2 rounded-full bg-black/22 px-3 py-2 backdrop-blur-sm" aria-label={`Photo ${activeSlide + 1} of ${slides.length}`}>
        {slides.map((slide, index) => (
          <button
            key={slide.image.src}
            type="button"
            aria-label={`Show workshop photo ${index + 1}`}
            aria-current={index === activeSlide ? "true" : undefined}
            onClick={() => setActiveSlide(index)}
            className={`h-1.5 rounded-full transition-[width,background-color] duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white ${
              index === activeSlide ? "w-7 bg-white" : "w-2.5 bg-white/45 hover:bg-white/75"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
