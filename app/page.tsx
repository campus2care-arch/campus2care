import Image, { type StaticImageData } from "next/image";

import logo from "../public/images/C2C-logo.png";
import andrew from "../public/images/Andrew.jpg";
import meghan from "../public/images/Meghan.jpg";
import josh from "../public/images/Josh.jpg";
import drCharland from "../public/images/DrCharland.png";
import workshopHero from "../public/images/events/hero-sept13-workshop.webp";
import workshopConversation from "../public/images/events/workshop-sept13-1.webp";
import workshopCollaboration from "../public/images/events/workshop-sept13-2.webp";
import workshopCommunity from "../public/images/events/origin-workshop.webp";
import ScrollEffects from "./scroll-effects";

const applicationLink =
  "https://docs.google.com/forms/d/e/1FAIpQLSfFWC8NTn891bBee-Fd1Rsb8Wdo_yorVWmiWetkWELdSzEdqw/viewform?ouid=101453949449250741173&usp=sharing";
const donateLink = "https://buy.stripe.com/fZudRa2hL4qLcf9egt57W00";
const portalLink = "https://volunteers.campus2care.org/login";

const steps = [
  {
    number: "01",
    title: "Share your interest",
    description:
      "Tell us about your goals, availability, and what you hope to learn through service.",
  },
  {
    number: "02",
    title: "Interview with our team",
    description:
      "We discuss fit, expectations, communication, and the responsibilities of hospital volunteering.",
  },
  {
    number: "03",
    title: "Receive a program decision",
    description:
      "Accepted students join Campus2Care. This is not the same as hospital clearance or placement.",
  },
  {
    number: "04",
    title: "Explore site fit",
    description:
      "We review your schedule, interests, transportation, and the pathways currently available.",
  },
  {
    number: "05",
    title: "Apply to the hospital",
    description:
      "You complete the selected hospital's own volunteer application and required documentation.",
  },
  {
    number: "06",
    title: "Complete clearance",
    description:
      "The hospital manages screening, health clearance, orientation, training, and final approval.",
  },
  {
    number: "07",
    title: "Prepare with Campus2Care",
    description:
      "Workshops and check-ins reinforce boundaries, communication, reliability, and patient-centered service.",
  },
  {
    number: "08",
    title: "Serve and stay connected",
    description:
      "Volunteer in the role assigned by the hospital while tracking progress and staying connected to your cohort.",
  },
];

const hospitalSites = [
  {
    name: "Brigham and Women's Hospital",
    shortName: "BWH",
    pathway: "Medical Career Exploration Program",
    summary:
      "A structured hospital volunteer pathway for students ready to make a consistent weekly commitment.",
    details: [
      "At least six months",
      "One 3 to 4 hour shift each week",
      "Common blocks include 9 AM to noon or 1 to 4 PM",
      "Hospital clearance and role assignment required",
    ],
  },
  {
    name: "Boston Medical Center",
    shortName: "BMC",
    pathway: "Hospital volunteer opportunities",
    summary:
      "Campus2Care helps students enter BMC's established volunteer process and prepare for service.",
    details: [
      "At least six months",
      "A minimum of 3 hours each week",
      "Main campus, Brighton, or Brockton based on availability",
      "Students identify Campus2Care as their referral source",
    ],
  },
  {
    name: "Tufts Medical Center",
    shortName: "Tufts",
    pathway: "College volunteer pathway",
    summary:
      "A longer-term pathway for students who can protect a reliable weekday hospital shift.",
    details: [
      "One-year commitment with academic breaks",
      "One fixed 3 to 4 hour shift each week",
      "Weekday daytime availability is important",
      "The hospital assigns volunteer roles after clearance",
    ],
  },
];

const leadership: Array<{
  name: string;
  title: string;
  image: StaticImageData;
  imageClass?: string;
}> = [
  {
    name: "Andrew Makar",
    title: "Founder & President",
    image: andrew,
  },
  {
    name: "Meghan Kelly",
    title: "Co-Vice President",
    image: meghan,
    imageClass: "object-[center_20%]",
  },
  {
    name: "Joshua Mueller",
    title: "Co-Vice President",
    image: josh,
  },
  {
    name: "Dr. Danuta Charland",
    title: "Faculty Advisor & University Liaison",
    image: drCharland,
    imageClass: "object-[center_12%]",
  },
];

const faqs = [
  {
    question: "Who can apply?",
    answer:
      "Campus2Care welcomes undergraduate students interested in healthcare, service, and patient-centered work. Current hospital availability, location, schedule, and program capacity all affect matching.",
  },
  {
    question: "Do I need a CNA, EMT, or other certification?",
    answer:
      "No. These are nonclinical volunteer pathways. Hospitals provide the role-specific orientation and training required for approved volunteers.",
  },
  {
    question: "Does acceptance guarantee a hospital placement?",
    answer:
      "No. Campus2Care acceptance allows you to move forward in our program. Each hospital controls its own application, screening, clearance, role availability, and final approval.",
  },
  {
    question: "Can I choose my hospital site?",
    answer:
      "You can share your preferences. We discuss fit based on your availability, transportation, interests, hospital requirements, and open pathways, but no specific site or role is guaranteed.",
  },
  {
    question: "What is the time commitment?",
    answer:
      "Most pathways require a fixed weekly shift of 3 to 4 hours. BWH and BMC generally require at least six months, while Tufts generally requires one year with academic breaks.",
  },
  {
    question: "What does Campus2Care provide?",
    answer:
      "We recruit and interview students, help assess pathway fit, provide preparation workshops and check-ins, build cohort community, and help students stay organized throughout the process.",
  },
  {
    question: "What does the hospital control?",
    answer:
      "The hospital controls its volunteer application, health and background requirements, orientation, training, scheduling, role assignment, policies, and final clearance to begin.",
  },
  {
    question: "When should I use the volunteer portal?",
    answer:
      "Use the portal after Campus2Care gives you access. It is the home for program milestones, check-ins, and hour tracking. Hospital systems remain separate and must be completed as directed by each site.",
  },
];

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="h-4 w-4"
    >
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
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className="mt-0.5 h-5 w-5 shrink-0"
    >
      <path
        d="m4 10 4 4 8-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#f7f7f4] text-[#181818]">
      <ScrollEffects />
      <a
        href="#main-content"
        className="sr-only z-[100] bg-white px-4 py-3 font-bold text-[#b3131b] focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-50 border-b border-black/8 bg-[#f7f7f4]/88 shadow-[0_8px_30px_rgba(20,20,18,0.035)] backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
          <a href="#home" className="flex items-center gap-3" aria-label="Campus2Care home">
            <Image
              src={logo}
              alt=""
              className="h-10 w-10 rounded-full object-cover"
              priority
            />
            <span className="text-[1.05rem] font-extrabold tracking-[-0.02em]">
              Campus2Care
            </span>
          </a>

          <nav className="hidden items-center gap-7 text-sm font-semibold lg:flex" aria-label="Primary navigation">
            <a className="nav-link" href="#how-it-works">How it works</a>
            <a className="nav-link" href="#hospital-sites">Hospital sites</a>
            <a className="nav-link" href="#experience">Student experience</a>
            <a className="nav-link" href="#about">About</a>
            <a className="nav-link" href="#leadership">Leadership</a>
            <a className="nav-link" href="#donate">Donate</a>
          </nav>

          <div className="hidden items-center gap-2 sm:flex">
            <a
              href={portalLink}
              target="_blank"
              rel="noopener noreferrer"
              className="button button-secondary"
            >
              Volunteer Portal
            </a>
            <a
              href={applicationLink}
              target="_blank"
              rel="noopener noreferrer"
              className="button button-primary"
            >
              Apply <ArrowIcon />
            </a>
          </div>

          <details className="mobile-menu sm:hidden">
            <summary aria-label="Open navigation menu">
              <span></span><span></span><span></span>
            </summary>
            <nav aria-label="Mobile navigation">
              <a href="#how-it-works">How it works</a>
              <a href="#hospital-sites">Hospital sites</a>
              <a href="#experience">Student experience</a>
              <a href="#about">About</a>
              <a href="#leadership">Leadership</a>
              <a href="#donate">Donate</a>
              <a href={portalLink} target="_blank" rel="noopener noreferrer">Volunteer Portal</a>
              <a className="mobile-apply" href={applicationLink} target="_blank" rel="noopener noreferrer">Apply now</a>
            </nav>
          </details>
        </div>
      </header>

      <div id="main-content">
        <section id="home" className="section-anchor relative bg-[#f7f7f4]">
          <div className="mx-auto grid min-h-[720px] max-w-[1440px] items-center gap-14 px-5 py-16 sm:px-8 lg:grid-cols-[0.94fr_1.06fr] lg:gap-20 lg:px-12 lg:py-24">
            <div className="max-w-3xl" data-reveal="left">
              <p className="eyebrow">Student-led nonprofit · Founded at Boston University</p>
              <h1 className="mt-7 max-w-3xl text-[clamp(3.4rem,6vw,6.6rem)] font-black leading-[0.9] tracking-[-0.06em]">
                Find your place in hospital service.
              </h1>
              <p className="mt-8 max-w-2xl text-xl leading-8 text-[#555550] sm:text-2xl sm:leading-9">
                Campus2Care helps students prepare for and navigate hospital volunteer pathways, with mentorship and community behind them from application through service.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <a
                  href={applicationLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="button button-primary button-large"
                >
                  Apply to Campus2Care <ArrowIcon />
                </a>
                <a href="#how-it-works" className="button button-secondary button-large">
                  See how placement works
                </a>
              </div>
              <p className="mt-5 text-sm leading-6 text-[#6f6f68]">
                Campus2Care acceptance does not guarantee hospital clearance, placement, or a specific role.
              </p>
            </div>

            <div className="media-reveal relative" data-reveal="scale">
              <div className="hero-frame relative aspect-[4/3] overflow-hidden rounded-[2rem] bg-[#deded8]">
                <Image
                  src={workshopHero}
                  alt="Campus2Care leadership working with a full room of students at the September 13 workshop"
                  fill
                  priority
                  sizes="(max-width: 1024px) 100vw, 52vw"
                  className="object-cover object-center"
                />
                <div className="absolute inset-x-4 bottom-4 rounded-[1.25rem] border border-white/15 bg-black/58 px-5 py-4 text-white shadow-[0_18px_50px_rgba(0,0,0,0.22)] backdrop-blur-md sm:inset-x-5 sm:bottom-5 sm:px-6 sm:py-5">
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-white/70">September 13 student workshop</p>
                  <p className="mt-1.5 max-w-xl text-lg font-semibold leading-6 sm:text-xl sm:leading-7">Students preparing together for hospital service.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-label="Current hospital pathways" className="border-y border-black/10 bg-white">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-5 px-5 py-6 sm:px-8 md:flex-row md:items-center md:justify-between lg:px-12" data-reveal="up">
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#777770]">Current hospital pathways</p>
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-base font-extrabold tracking-[-0.02em] sm:text-lg">
              <span>Brigham and Women&apos;s</span>
              <span>Boston Medical Center</span>
              <span>Tufts Medical Center</span>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="section-anchor bg-white py-24 sm:py-32">
          <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
            <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
              <div data-reveal="left">
                <p className="eyebrow">How it works</p>
                <h2 className="section-title mt-5">One process. Two teams. Clear responsibilities.</h2>
                <p className="section-copy mt-6">
                  We help you arrive prepared. Hospitals make the final decisions about clearance, scheduling, and volunteer roles.
                </p>
                <div className="mt-8 border-l-2 border-[#b3131b] pl-5">
                  <p className="font-bold">The important distinction</p>
                  <p className="mt-2 leading-7 text-[#5d5d58]">
                    An offer from Campus2Care means you have been accepted into our program. You may begin only after the hospital confirms every requirement is complete.
                  </p>
                </div>
              </div>

              <ol className="grid gap-x-10 gap-y-0 sm:grid-cols-2" data-reveal="right">
                {steps.map((step) => (
                  <li key={step.number} className="border-t border-black/15 py-7">
                    <div className="flex gap-5">
                      <span className="text-sm font-black tracking-[0.12em] text-[#b3131b]">{step.number}</span>
                      <div>
                        <h3 className="text-xl font-extrabold tracking-[-0.025em]">{step.title}</h3>
                        <p className="mt-2 leading-7 text-[#62625d]">{step.description}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section id="hospital-sites" className="section-anchor bg-[#151515] py-24 text-white sm:py-32">
          <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
            <div className="max-w-4xl" data-reveal="up">
              <p className="eyebrow eyebrow-light">Hospital pathways</p>
              <h2 className="section-title mt-5 text-white">Different sites. Different commitments. The same expectation of reliability.</h2>
              <p className="mt-6 max-w-3xl text-lg leading-8 text-white/65">
                Site availability changes. Campus2Care discusses fit with accepted students, then each hospital runs its own application and clearance process.
              </p>
            </div>

            <div className="reveal-stagger mt-14 grid border-y border-white/15 lg:grid-cols-3">
              {hospitalSites.map((site, index) => (
                <article
                  key={site.shortName}
                  className={`py-9 lg:px-8 lg:py-12 ${index > 0 ? "border-t border-white/15 lg:border-l lg:border-t-0" : ""} ${index === 0 ? "lg:pl-0" : ""}`}
                  data-reveal="up"
                >
                  <p className="text-sm font-black uppercase tracking-[0.18em] text-[#ff6670]">{site.shortName}</p>
                  <h3 className="mt-4 text-3xl font-black leading-tight tracking-[-0.04em]">{site.name}</h3>
                  <p className="mt-3 font-semibold text-white/70">{site.pathway}</p>
                  <p className="mt-6 leading-7 text-white/65">{site.summary}</p>
                  <ul className="mt-7 space-y-3 text-sm leading-6 text-white/82">
                    {site.details.map((detail) => (
                      <li key={detail} className="flex gap-3">
                        <span className="text-[#ff6670]"><CheckIcon /></span>
                        <span>{detail}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>

            <div className="mt-8 flex flex-col justify-between gap-5 rounded-[1.5rem] border border-white/15 p-6 sm:flex-row sm:items-center sm:p-8" data-reveal="up">
              <p className="max-w-3xl leading-7 text-white/70">
                Commitments and availability are subject to hospital policy and may change. We review the current pathway with each student before referral.
              </p>
              <a href={applicationLink} target="_blank" rel="noopener noreferrer" className="button button-light shrink-0">
                Start your application <ArrowIcon />
              </a>
            </div>
          </div>
        </section>

        <section id="experience" className="section-anchor bg-[#f7f7f4] py-24 sm:py-32">
          <div className="mx-auto grid max-w-[1440px] gap-14 px-5 sm:px-8 lg:grid-cols-2 lg:items-center lg:gap-20 lg:px-12">
            <div className="media-reveal grid grid-cols-2 gap-3" data-reveal="left">
              <div className="relative aspect-[4/5] overflow-hidden rounded-[1.5rem] bg-[#ddd]">
                <Image
                  src={workshopConversation}
                  alt="Campus2Care faculty advisor speaking with a student at a workshop"
                  fill
                  sizes="(max-width: 1024px) 50vw, 25vw"
                  className="object-cover"
                />
              </div>
              <div className="relative mt-12 aspect-[4/5] overflow-hidden rounded-[1.5rem] bg-[#ddd]">
                <Image
                  src={workshopCollaboration}
                  alt="Campus2Care students collaborating during a workshop"
                  fill
                  sizes="(max-width: 1024px) 50vw, 25vw"
                  className="object-cover"
                />
              </div>
            </div>

            <div data-reveal="right">
              <p className="eyebrow">The student experience</p>
              <h2 className="section-title mt-5">You are not navigating the process alone.</h2>
              <p className="section-copy mt-6">
                Campus2Care adds the preparation, accountability, and community that can be hard to find when students approach hospital volunteering on their own.
              </p>
              <div className="mt-10 divide-y divide-black/15 border-y border-black/15">
                {[
                  ["Readiness workshops", "Practice communication, boundaries, escalation, and professional expectations before service begins."],
                  ["Mentorship and check-ins", "Stay connected during hospital onboarding and after you begin volunteering."],
                  ["A clear volunteer portal", "Track milestones, program check-ins, and hours without replacing the hospital's own systems."],
                  ["Cohort community", "Learn alongside students who are preparing for the same standard of consistent, patient-centered service."],
                ].map(([title, description]) => (
                  <div key={title} className="grid gap-2 py-5 sm:grid-cols-[0.7fr_1.3fr] sm:gap-8">
                    <h3 className="font-extrabold tracking-[-0.02em]">{title}</h3>
                    <p className="leading-7 text-[#62625d]">{description}</p>
                  </div>
                ))}
              </div>
              <a href={portalLink} target="_blank" rel="noopener noreferrer" className="button button-secondary mt-8">
                Open volunteer portal <ArrowIcon />
              </a>
            </div>
          </div>
        </section>

        <section id="about" className="section-anchor bg-[#b3131b] py-24 text-white sm:py-32">
          <div className="mx-auto grid max-w-[1440px] gap-14 px-5 sm:px-8 lg:grid-cols-[0.78fr_1.22fr] lg:gap-24 lg:px-12">
            <div data-reveal="left">
              <p className="eyebrow eyebrow-light">Our mission</p>
              <p className="mt-6 text-3xl font-black leading-tight tracking-[-0.045em] sm:text-5xl">
                Patients deserve someone who has time to listen.
              </p>
            </div>
            <div data-reveal="right">
              <h2 className="text-3xl font-black leading-tight tracking-[-0.04em] sm:text-5xl">
                To connect pre-health students with hospitalized patients who need presence, support, and advocacy, while giving students meaningful exposure to compassionate patient-centered care.
              </h2>
              <div className="mt-10 grid gap-8 border-t border-white/30 pt-8 sm:grid-cols-2">
                <div>
                  <h3 className="font-extrabold uppercase tracking-[0.12em]">Our role</h3>
                  <p className="mt-3 leading-7 text-white/75">Recruit, interview, prepare, mentor, and help accepted students navigate available hospital pathways.</p>
                </div>
                <div>
                  <h3 className="font-extrabold uppercase tracking-[0.12em]">Role boundaries</h3>
                  <p className="mt-3 leading-7 text-white/75">Campus2Care volunteers are nonclinical. They follow hospital policy, respect privacy, and escalate concerns through approved channels.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="bg-white py-24 sm:py-32">
          <div className="mx-auto grid max-w-[1440px] gap-12 px-5 sm:px-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center lg:gap-20 lg:px-12">
            <div className="media-reveal relative aspect-[16/11] overflow-hidden rounded-[1.75rem] bg-[#ddd]" data-reveal="left">
              <Image
                src={workshopCommunity}
                alt="Campus2Care students participating in a hospital volunteer preparation workshop"
                fill
                sizes="(max-width: 1024px) 100vw, 48vw"
                className="object-cover"
              />
            </div>
            <div data-reveal="right">
              <p className="eyebrow">Why Campus2Care began</p>
              <h2 className="section-title mt-5">A lesson in the power of consistent presence.</h2>
              <p className="section-copy mt-6">
                Campus2Care was inspired in part by the story of a patient we call Daniel and his spouse, Elena. Their names have been changed to protect their privacy. During Daniel&apos;s hospitalizations, he was often unable to fully express his own needs, and Elena became his voice at the bedside.
              </p>
              <p className="section-copy mt-5">
                Her presence demonstrated how meaningful compassionate advocacy can be during serious illness. That lesson continues to guide how we prepare students to show up with empathy, humility, and respect for their role.
              </p>
            </div>
          </div>
        </section>

        <section id="leadership" className="section-anchor bg-[#efefeb] py-24 sm:py-32">
          <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
            <div className="max-w-3xl" data-reveal="up">
              <p className="eyebrow">Leadership</p>
              <h2 className="section-title mt-5">Built by students. Strengthened by guidance.</h2>
            </div>
            <div className="reveal-stagger mt-14 grid grid-cols-2 gap-x-5 gap-y-10 lg:grid-cols-4 lg:gap-8">
              {leadership.map((person) => (
                <article key={person.name} data-reveal="up">
                  <div className="relative aspect-[4/5] overflow-hidden rounded-[1.5rem] bg-[#d8d8d2]">
                    <Image
                      src={person.image}
                      alt={person.name}
                      fill
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 50vw, 25vw"
                      className={`object-cover ${person.imageClass ?? "object-center"}`}
                    />
                  </div>
                  <h3 className="mt-5 text-xl font-black tracking-[-0.03em] sm:text-2xl">{person.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-[#62625d] sm:text-base">{person.title}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-white py-16 sm:py-20">
          <div className="mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12">
            <div className="grid gap-8 rounded-[1.75rem] bg-[#151515] px-6 py-10 text-white shadow-[0_24px_70px_rgba(0,0,0,0.12)] sm:px-10 sm:py-14 lg:grid-cols-[1fr_auto] lg:items-center lg:px-14" data-reveal="scale">
              <div>
                <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#ff737c]">Applications are the first step</p>
                <h2 className="mt-3 max-w-4xl text-3xl font-black tracking-[-0.04em] sm:text-5xl">Ready to find the hospital pathway that fits?</h2>
              </div>
              <a href={applicationLink} target="_blank" rel="noopener noreferrer" className="button button-light button-large">
                Apply now <ArrowIcon />
              </a>
            </div>
          </div>
        </section>

        <section id="donate" className="section-anchor bg-white py-24 sm:py-32">
          <div className="mx-auto grid max-w-[1200px] gap-10 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center lg:gap-20">
            <div className="media-reveal flex items-center justify-center overflow-hidden rounded-[1.75rem] bg-[#f3f3ef] p-12 sm:p-20" data-reveal="left">
              <Image src={logo} alt="Campus2Care logo" className="h-52 w-52 rounded-full object-cover sm:h-64 sm:w-64" />
            </div>
            <div data-reveal="right">
              <p className="eyebrow">Support our work</p>
              <h2 className="section-title mt-5">Help more students arrive prepared to serve.</h2>
              <p className="section-copy mt-6">
                Donations help Campus2Care deliver student workshops, mentorship, volunteer resources, and the infrastructure needed to support growing hospital pathways.
              </p>
              <a href={donateLink} target="_blank" rel="noopener noreferrer" className="button button-primary button-large mt-8">
                Donate securely <ArrowIcon />
              </a>
              <p className="mt-6 max-w-2xl text-sm leading-6 text-[#6a6a64]">
                Campus2Care is a registered 501(c)(3) nonprofit organization, EIN 41-5148269. Contributions are tax-deductible to the extent allowed by law. Donations are processed securely through Stripe, and Campus2Care does not store payment information.
              </p>
            </div>
          </div>
        </section>

        <section id="faq" className="section-anchor border-t border-black/10 bg-[#f7f7f4] py-24 sm:py-32">
          <div className="mx-auto grid max-w-[1440px] gap-12 px-5 sm:px-8 lg:grid-cols-[0.68fr_1.32fr] lg:gap-20 lg:px-12">
            <div data-reveal="left">
              <p className="eyebrow">Questions, answered</p>
              <h2 className="section-title mt-5">Know what to expect before you apply.</h2>
              <p className="section-copy mt-6">Still have a question? Email us at <a className="font-bold text-[#b3131b] underline decoration-1 underline-offset-4" href="mailto:campus2care@gmail.com">campus2care@gmail.com</a>.</p>
            </div>
            <div className="border-t border-black/15" data-reveal="right">
              {faqs.map((faq) => (
                <details key={faq.question} className="faq-item border-b border-black/15">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-5 py-6 text-left text-lg font-extrabold tracking-[-0.02em] sm:text-xl">
                    {faq.question}
                    <span aria-hidden="true" className="faq-plus shrink-0 text-2xl font-normal text-[#b3131b]">+</span>
                  </summary>
                  <p className="max-w-3xl pb-6 pr-10 leading-7 text-[#62625d]">{faq.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section id="contact" className="section-anchor bg-[#151515] py-24 text-white sm:py-32">
          <div className="mx-auto grid max-w-[1200px] gap-12 px-5 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <div data-reveal="left">
              <p className="eyebrow eyebrow-light">Contact</p>
              <h2 className="section-title mt-5 text-white">Let&apos;s talk.</h2>
              <p className="mt-6 max-w-md text-lg leading-8 text-white/65">Questions from students, hospitals, universities, and supporters are welcome.</p>
              <a className="mt-8 inline-block text-xl font-bold underline decoration-white/30 underline-offset-8 hover:decoration-white" href="mailto:campus2care@gmail.com">campus2care@gmail.com</a>
            </div>
            <form action="https://formspree.io/f/xgorozlb" method="POST" className="grid gap-5 sm:grid-cols-2" data-reveal="right">
              <label className="contact-field">
                <span>Name</span>
                <input type="text" name="name" autoComplete="name" required />
              </label>
              <label className="contact-field">
                <span>Email</span>
                <input type="email" name="email" autoComplete="email" required />
              </label>
              <label className="contact-field sm:col-span-2">
                <span>Message</span>
                <textarea name="message" rows={5} required />
              </label>
              <button type="submit" className="button button-light justify-center sm:col-span-2 sm:justify-self-start">Send message <ArrowIcon /></button>
            </form>
          </div>
        </section>
      </div>

      <footer className="border-t border-white/10 bg-[#151515] text-white">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-5 py-10 sm:px-8 md:flex-row md:items-end md:justify-between lg:px-12">
          <div>
            <div className="flex items-center gap-3">
              <Image src={logo} alt="" className="h-10 w-10 rounded-full object-cover" />
              <span className="text-lg font-black">Campus2Care</span>
            </div>
            <p className="mt-4 max-w-lg text-sm leading-6 text-white/50">A student-led 501(c)(3) nonprofit helping students prepare for and navigate hospital volunteer pathways.</p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm font-bold">
            <a className="hover:text-[#ff737c]" href={portalLink} target="_blank" rel="noopener noreferrer">Volunteer Portal</a>
            <a className="hover:text-[#ff737c]" href={applicationLink} target="_blank" rel="noopener noreferrer">Apply</a>
            <a className="hover:text-[#ff737c]" href={donateLink} target="_blank" rel="noopener noreferrer">Donate</a>
            <a className="hover:text-[#ff737c]" href="#faq">FAQ</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
