export default function Home() {
  const faqs = [
    {
      question: "Who can apply?",
      answer:
        "The first pilot is geared toward Boston University students interested in healthcare, with priority given to students who already have CNA or EMT experience so the program can start safely and intentionally.",
    },
    {
      question: "What is the initial commitment?",
      answer:
        "The pilot begins through the standard volunteer route, so students can participate without a large rigid commitment while the model is being refined on the unit.",
    },
    {
      question: "What happens after the pilot?",
      answer:
        "Once the pilot is running well, the long-term goal is to transition students into the Medical Career Exploration Program, which involves a fuller 140-hour commitment.",
    },
  ];

  const formLink =
    "https://docs.google.com/forms/d/e/1FAIpQLSfFWC8NTn891bBee-Fd1Rsb8Wdo_yorVWmiWetkWELdSzEdqw/viewform?usp=sharing&ouid=101453949449250741173";

  return (
    <main className="min-h-screen bg-[#f5f5f5] text-[#1f2937]">
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#cc0000] text-white shadow-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-8">
          <div className="text-2xl font-black tracking-tight">Campus2Care</div>

          <nav className="hidden items-center gap-8 text-sm font-semibold md:flex">
            <a href="#home" className="transition hover:opacity-80">
              Home
            </a>
            <a href="#about" className="transition hover:opacity-80">
              About
            </a>
            <a href="#apply" className="transition hover:opacity-80">
              Apply
            </a>
            <a href="#faq" className="transition hover:opacity-80">
              FAQ
            </a>
            <a href="#contact" className="transition hover:opacity-80">
              Contact
            </a>
            <a
              href="mailto:campus2care@gmail.com"
              className="transition hover:opacity-80"
            >
              campus2care@gmail.com
            </a>
          </nav>

          <a
            href={formLink}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl border border-white/70 px-4 py-2 text-sm font-bold transition hover:bg-white hover:text-[#cc0000]"
          >
            Apply Now
          </a>
        </div>
      </header>

      <section id="home" className="bg-[#cc0000] text-white">
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-6 py-16 lg:grid-cols-2 lg:px-8 lg:py-20">
          <div>
            <div className="inline-block bg-white/10 px-4 py-2 text-sm font-semibold uppercase tracking-[0.15em]">
              Boston University Student Advocacy Initiative
            </div>

            <h1 className="mt-6 max-w-xl text-5xl font-black leading-[0.95] sm:text-6xl">
              Support Patients. Gain Real Experience.
            </h1>

            <p className="mt-6 max-w-lg text-xl text-white/90">
              Connecting BU students with patients who lack advocacy.
            </p>

            <div className="mt-8 flex flex-wrap gap-4">
              <a
                href={formLink}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-2xl bg-white px-6 py-3 font-bold text-[#cc0000] shadow-lg transition hover:scale-[1.02]"
              >
                Apply Now
              </a>
              <a
                href="#about"
                className="rounded-2xl border border-white/70 px-6 py-3 font-bold transition hover:bg-white/10"
              >
                Learn More
              </a>
            </div>
          </div>

          <div className="relative">
            <img
              src="/images/hero.jpg"
              alt="Healthcare student supporting a patient"
              className="h-full max-h-[460px] w-full rounded-[2rem] object-cover shadow-2xl"
            />
          </div>
        </div>
      </section>

      <section id="about" className="bg-white py-16">
        <div className="mx-auto grid max-w-7xl gap-8 px-6 md:grid-cols-3 lg:px-8">
          <div className="rounded-3xl bg-[#f8f8f8] p-8 shadow-sm">
            <h2 className="text-2xl font-black text-[#cc0000]">Mission</h2>
            <p className="mt-4 text-lg leading-8 text-neutral-700">
              To connect pre-health students with patients who lack advocacy,
              providing meaningful clinical experience while ensuring no patient
              faces the healthcare system alone.
            </p>
          </div>

          <div className="rounded-3xl bg-[#f8f8f8] p-8 shadow-sm">
            <h2 className="text-2xl font-black text-[#cc0000]">Our Story</h2>
            <p className="mt-4 text-lg leading-8 text-neutral-700">
              Built from real hospital experience, Campus2Care addresses a clear
              gap: patients who need presence and advocacy, and students who
              need meaningful opportunities to learn what compassionate care
              actually looks like.
            </p>
          </div>

          <div className="rounded-3xl bg-[#f8f8f8] p-8 shadow-sm">
            <h2 className="text-2xl font-black text-[#cc0000]">Vision</h2>
            <p className="mt-4 text-lg leading-8 text-neutral-700">
              A future where advocacy is built into healthcare training from day
              one and every patient has someone in their corner.
            </p>
          </div>
        </div>
      </section>

      <section id="apply" className="bg-[#f2f2f2] py-16">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 lg:grid-cols-[1.15fr_0.85fr] lg:px-8">
          <div className="rounded-[2rem] bg-white p-10 shadow-sm">
            <h2 className="max-w-3xl text-4xl font-black leading-tight text-[#1f2937]">
              Make a Difference for Patients and Your Future in Healthcare.
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-neutral-700">
              Campus2Care connects BU students with patients at Brigham and
              Women&apos;s Hospital who need companionship, support, and
              advocacy. The program starts as a closely monitored pilot so
              students can gain real exposure while helping patients feel less
              alone.
            </p>
            <a
              href={formLink}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-8 inline-block rounded-2xl bg-[#cc0000] px-6 py-3 font-bold text-white shadow-md transition hover:scale-[1.02]"
            >
              Apply Now
            </a>
          </div>

          <div className="rounded-[2rem] bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-2xl font-bold text-neutral-800">
              Campus2Care Flyer
            </h2>

            <div className="overflow-hidden rounded-2xl border border-neutral-200">
              <img
                src="/images/flyer.jpg"
                alt="Campus2Care flyer"
                className="w-full object-cover"
              />
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <a
                href="/images/flyer.jpg"
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border border-[#cc0000] px-5 py-3 font-semibold text-[#cc0000]"
              >
                Preview Flyer
              </a>

              <a
                href="/images/flyer.jpg"
                download="Campus2Care-Flyer.jpg"
                className="rounded-xl bg-[#cc0000] px-5 py-3 font-semibold text-white"
              >
                Download Flyer
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[#efefef] py-16">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 lg:grid-cols-[0.95fr_1.05fr] lg:px-8">
          <div className="rounded-[2rem] bg-white p-10 shadow-sm">
            <h2 className="text-center text-4xl font-black text-[#1f2937]">
              Meet Our Leadership Team
            </h2>

            <div className="mt-10 flex flex-col items-center justify-center gap-10 md:flex-row md:gap-14">
              <div className="text-center">
                <div className="mx-auto h-48 w-48 overflow-hidden rounded-full shadow-lg">
                  <img
                    src="/images/Andrew.jpg"
                    alt="Andrew Makar"
                    className="h-full w-full scale-[1.18] object-cover object-[center_-5%]"
                  />
                </div>
                <h3 className="mt-4 text-3xl font-black text-[#cc0000]">
                  Andrew Makar
                </h3>
                <p className="text-lg text-neutral-700">
                  Founder &amp; President
                </p>
              </div>

              <div className="text-center">
                <div className="mx-auto h-48 w-48 overflow-hidden rounded-full shadow-lg">
                  <img
                    src="/images/Meghan.jpg"
                    alt="Meghan Kelly"
                    className="h-full w-full scale-[1.08] object-cover object-[center_20%]"
                  />
                </div>
                <h3 className="mt-4 text-3xl font-black text-[#cc0000]">
                  Meghan Kelly
                </h3>
                <p className="text-lg text-neutral-700">Vice President</p>
              </div>
            </div>
          </div>

          <div className="rounded-[2rem] bg-white p-8 shadow-sm">
            <h2 className="text-center text-4xl font-black uppercase tracking-tight text-[#1f2937]">
              Roadmap to Impact
            </h2>

            <div className="mt-8 grid gap-4">
              <div className="rounded-2xl bg-[#cc0000] p-5 text-white">
                <div className="text-sm font-bold uppercase tracking-[0.15em] text-white/80">
                  Phase 1
                </div>
                <div className="mt-1 text-2xl font-black">ICU Pilot Program</div>
                <p className="mt-2 text-white/90">
                  Launch with a small group of BU students through the standard
                  volunteer route.
                </p>
              </div>

              <div className="rounded-2xl bg-[#f3f4f6] p-5">
                <div className="text-sm font-bold uppercase tracking-[0.15em] text-[#cc0000]">
                  Phase 2
                </div>
                <div className="mt-1 text-2xl font-black text-[#1f2937]">
                  Expand Within BWH
                </div>
                <p className="mt-2 text-neutral-700">
                  Refine the model, document what works, and expand carefully to
                  additional students and settings.
                </p>
              </div>

              <div className="rounded-2xl bg-[#f3f4f6] p-5">
                <div className="text-sm font-bold uppercase tracking-[0.15em] text-[#cc0000]">
                  Phase 3
                </div>
                <div className="mt-1 text-2xl font-black text-[#1f2937]">
                  Reach Across Campus
                </div>
                <p className="mt-2 text-neutral-700">
                  Grow beyond the first cohort and eventually extend the model
                  to more schools and hospital partners.
                </p>
              </div>
            </div>

            <a
              href={formLink}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-block rounded-xl bg-[#cc0000] px-5 py-3 font-bold text-white"
            >
              Apply Now
            </a>
          </div>
        </div>
      </section>

      <section id="contact" className="bg-[#cc0000] py-16 text-white">
        <div className="mx-auto grid max-w-7xl gap-10 px-6 lg:grid-cols-2 lg:px-8">
          <div className="rounded-[2rem] bg-white/10 p-8 shadow-sm">
            <h2 className="text-3xl font-bold">Contact Us</h2>
            <p className="mt-2 text-white/80">
              Questions? Reach out and we&apos;ll get back to you.
            </p>

            <form
              action="https://formspree.io/f/xgorozlb"
              method="POST"
              className="mt-6 space-y-4"
            >
              <input
                type="text"
                name="name"
                placeholder="Your Name"
                required
                className="w-full rounded-xl px-4 py-3 text-black outline-none"
              />

              <input
                type="email"
                name="email"
                placeholder="Your Email"
                required
                className="w-full rounded-xl px-4 py-3 text-black outline-none"
              />

              <textarea
                name="message"
                placeholder="Your Message"
                rows={5}
                required
                className="w-full rounded-xl px-4 py-3 text-black outline-none"
              />

              <button
                type="submit"
                className="w-full rounded-xl bg-white py-3 font-bold text-[#cc0000] transition hover:opacity-90"
              >
                Send Message
              </button>
            </form>

            <p className="mt-4 text-sm text-white/70">
              Or email us directly: campus2care@gmail.com
            </p>
          </div>

          <div
            id="faq"
            className="rounded-[2rem] bg-white p-10 text-[#1f2937] shadow-sm"
          >
            <h2 className="text-5xl font-black">Frequently Asked Questions</h2>

            <div className="mt-8 space-y-6">
              {faqs.map((faq) => (
                <div
                  key={faq.question}
                  className="border-b border-neutral-200 pb-5"
                >
                  <h3 className="text-2xl font-black">{faq.question}</h3>
                  <p className="mt-3 text-lg leading-8 text-neutral-700">
                    {faq.answer}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}