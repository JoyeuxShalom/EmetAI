// EmetAI landing — calm, modern, futuristic. Emet (אמת) = Truth.
//
// The job of this page is hard in a specific way: what EmetAI does is
// invisible in a screenshot. A preacher speaks and a verse appears — that is
// a sequence, not a picture. So the hero performs it instead of describing
// it (see LiveDemo), and the prose gets out of the way.
//
// Words were cut hard. The previous version explained six features in four
// lines each; a church deciding in ten seconds reads none of it. Every claim
// here is either one line or demonstrated on screen.
//
// No stock photography, deliberately. The Studio has to work in a hall with
// poor internet, and a hero that waits on a 400 KB photograph from a CDN is
// slower than the product it is advertising. The atmosphere is CSS light and
// the real typography of the real projector.

import {
  IconAnswers,
  IconClips,
  IconHears,
  IconInterpreter,
  IconParaphrase,
  IconThreeUp,
} from "../components/FeatureIcons"
import LiveDemo from "../components/LiveDemo"
import Logo, { LogoMark } from "../components/Logo"
import ScrollRing from "../components/ScrollRing"
import { useAuth } from "../lib/auth"
import { useReveal } from "../lib/reveal"

const PROOF = [
  { big: "3", small: "languages, at once" },
  { big: "~2s", small: "from spoken to screen" },
  { big: "0", small: "typing during the sermon" },
]

const STEPS = [
  { n: "01", t: "Press Listen", b: "One button, at the start of the service." },
  { n: "02", t: "Preach", b: "Kinyarwanda, English or French. Say it however you say it." },
  { n: "03", t: "It appears", b: "The verse is on the wall before you finish the sentence." },
]

const FEATURES = [
  { Icon: IconHears, title: "Hears Kinyarwanda", body: "Not translated — heard, in the language it was spoken." },
  { Icon: IconParaphrase, title: "Catches paraphrase", body: "Quote from memory. It still knows the verse." },
  { Icon: IconThreeUp, title: "Three side by side", body: "Bibiliya Yera, KJV, Louis Segond — together." },
  { Icon: IconInterpreter, title: "Follows the interpreter", body: "Preacher and interpreter, told apart automatically." },
  { Icon: IconAnswers, title: "Answers questions", body: "“What does Elohim mean?” — on the screen." },
  { Icon: IconClips, title: "Cuts sermon clips", body: "A YouTube link in, social-ready clips out." },
]

export default function Landing() {
  const { user } = useAuth()
  const cta = user ? "#/app" : "#/register"
  useReveal()

  return (
    <main className="h-full overflow-y-auto bg-ink text-parchment">
      {/* Nav */}
      <nav className="sticky top-0 z-20 flex items-center justify-between border-b border-parchment/10 bg-ink/85 px-6 py-3 backdrop-blur">
        <Logo size={30} />
        <div className="flex items-center gap-2">
          <a href="#how" className="hidden rounded-md px-3 py-1.5 font-sans text-sm text-parchment-dim transition hover:text-parchment sm:block">
            How it works
          </a>
          <a href="#pricing" className="hidden rounded-md px-3 py-1.5 font-sans text-sm text-parchment-dim transition hover:text-parchment sm:block">
            Pricing
          </a>
          {user ? (
            <a href="#/app" className="rounded-md bg-gold px-4 py-1.5 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep">
              Open Studio →
            </a>
          ) : (
            <>
              <a href="#/login" className="rounded-md border border-parchment/20 px-3.5 py-1.5 font-sans text-sm text-parchment-dim transition hover:border-gold/60 hover:text-gold">
                Sign in
              </a>
              <a href="#/register" className="rounded-md bg-gold px-4 py-1.5 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep">
                Start free
              </a>
            </>
          )}
        </div>
      </nav>

      {/* ---------------------------------------------------------- Hero -- */}
      <section className="relative overflow-hidden px-6 pb-28 pt-36">
        <div className="aurora aurora-drift" />
        {/* Scripture turning past, in all three tongues the ear hears. */}
        <ScrollRing />
        {/* Pools the page's own ink between the ring and the words, so the
            scrolls fall away behind them and the headline reads as nearer. */}
        <div className="hero-scrim" />

        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <p className="animate-rise font-sans text-[0.65rem] uppercase tracking-[0.45em] text-gold/80">
            Emet · אמת · Truth
          </p>

          <h1
            className="animate-emerge mt-5 font-display text-[clamp(2.4rem,6.5vw,4.6rem)] font-[440] leading-[1.08]"
            style={{ animationDelay: "0.08s", textWrap: "balance" }}
          >
            Scripture, the moment it is{" "}
            <span className="italic text-gold">spoken</span>.
          </h1>

          <p
            className="animate-rise mx-auto mt-36 max-w-lg font-sans text-lg leading-relaxed text-parchment-dim sm:mt-6"
            style={{ animationDelay: "0.16s" }}
          >
            Your projection team stops typing. EmetAI listens and puts the verse
            on the screen.
          </p>

          <div
            className="animate-rise mt-9 flex flex-wrap items-center justify-center gap-3"
            style={{ animationDelay: "0.24s" }}
          >
            <a href={cta} className="rounded-lg bg-gold px-7 py-3 font-sans text-base font-medium text-ink shadow-lg shadow-gold/20 transition hover:-translate-y-0.5 hover:bg-gold-deep">
              {user ? "Open the Studio →" : "Start 14 days free →"}
            </a>
            <a href="#how" className="rounded-lg border border-parchment/20 px-7 py-3 font-sans text-base text-parchment-dim transition hover:border-gold/60 hover:text-gold">
              See it work
            </a>
          </div>

          <p className="animate-rise mt-4 font-sans text-xs text-parchment-dim/50" style={{ animationDelay: "0.3s" }}>
            No card needed · Made in Rwanda
          </p>
        </div>

        {/* The product, working.
            The gap above it has to clear the BOTTOM OF THE RING, not the last
            line of text, and the ring is a different size at each breakpoint —
            so this margin is too. Measured, as the lowest scroll swings past:
              phone  531px clear  (the ring only encloses the headline there,
                                   and the sentence and buttons sit between)
              tablet  32px        tight
              desktop −14px       touching, and overlapping on every turn
            Hence three values rather than one. A single number big enough for
            the desktop would have opened a second 100px hole on a phone that
            already had more air than it needed. */}
        <div
          className="animate-rise relative z-10 mt-56 sm:mt-64 lg:mt-80"
          style={{ animationDelay: "0.4s" }}
        >
          <LiveDemo />
        </div>
      </section>

      {/* --------------------------------------------------------- Proof -- */}
      <section className="border-t border-parchment/10 px-6 py-14">
        <div className="reveal mx-auto grid max-w-3xl grid-cols-3 gap-6 text-center">
          {PROOF.map((p) => (
            <div key={p.small}>
              <p className="font-display text-[clamp(1.8rem,4vw,2.8rem)] text-gold">{p.big}</p>
              <p className="mt-1 font-sans text-xs text-parchment-dim/70">{p.small}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------- How it works -- */}
      <section id="how" className="border-t border-parchment/10 px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="reveal text-center font-display text-[clamp(1.8rem,4vw,2.6rem)] font-[440]">
            Three steps to Sunday
          </h2>
          <div className="mt-14 grid gap-10 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <div
                key={s.n}
                className="reveal text-center"
                style={{ transitionDelay: `${i * 0.12}s` }}
              >
                <p className="font-display text-5xl text-gold/60">{s.n}</p>
                <h3 className="mt-3 font-sans text-lg font-semibold">{s.t}</h3>
                <p className="mt-2 font-sans text-sm leading-relaxed text-parchment-dim">{s.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ Features -- */}
      <section className="border-t border-parchment/10 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="reveal text-center font-display text-[clamp(1.8rem,4vw,2.6rem)] font-[440]">
            Built for a real service
          </h2>
          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                className="reveal group rounded-xl border border-parchment/10 bg-ink-soft p-6 hover:border-gold/40 hover:bg-ink-raise"
                style={{ transitionDelay: `${(i % 3) * 0.08}s` }}
              >
                <f.Icon className="h-8 w-8 text-parchment-dim transition-all duration-300 group-hover:scale-110 group-hover:text-parchment" />
                <h3 className="mt-3 font-sans text-base font-semibold text-parchment">{f.title}</h3>
                <p className="mt-1.5 font-sans text-sm leading-relaxed text-parchment-dim">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- Pricing -- */}
      <section id="pricing" className="border-t border-parchment/10 px-6 py-20">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="reveal font-display text-[clamp(1.8rem,4vw,2.6rem)] font-[440]">
            The ear is free. For ever.
          </h2>
          <p className="reveal mx-auto mt-3 max-w-xl font-sans text-parchment-dim">
            Every church hears the preacher. Add AI answers and clips when you are
            ready — monthly, or 12.5% less by the year, with MTN Mobile Money.
          </p>
          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            {[
              {
                name: "Free",
                price: "$0",
                per: "for ever",
                items: [
                  "AI ear — verses appear as spoken",
                  "“Emet, John 3:16” voice commands",
                  "Unlimited manual scripture search",
                  "Up to 3 versions side by side",
                  "Kinyarwanda, English, French",
                ],
                cta: "Start free",
                highlight: false,
              },
              {
                name: "Pro",
                price: "$20",
                per: "per month · or $210 a year",
                items: [
                  "Everything in Free",
                  "300 AI answers a month",
                  "Hebrew & Greek definitions on screen",
                  "10 sermon clips a month",
                ],
                cta: "Choose Pro",
                highlight: true,
              },
              {
                name: "Max",
                price: "$40",
                per: "per month · or $420 a year",
                items: [
                  "Everything in Pro",
                  "Unlimited AI answers",
                  "Unlimited sermon clips",
                  "Priority support",
                ],
                cta: "Choose Max",
                highlight: false,
              },
            ].map((p, i) => (
              <div
                key={p.name}
                className={`reveal rounded-2xl border p-7 text-left ${
                  p.highlight
                    ? "border-gold/60 bg-gold/5 shadow-lg shadow-gold/10"
                    : "border-parchment/10 bg-ink-soft hover:border-gold/30"
                }`}
                style={{ transitionDelay: `${i * 0.1}s` }}
              >
                <p className="font-sans text-sm uppercase tracking-[0.25em] text-parchment-dim">{p.name}</p>
                <p className="mt-3 font-display text-3xl text-parchment">{p.price}</p>
                <p className="font-sans text-xs text-parchment-dim/70">{p.per}</p>
                <ul className="mt-5 space-y-2">
                  {p.items.map((it) => (
                    <li key={it} className="font-sans text-sm text-parchment-dim">
                      <span className="mr-2 text-gold">✓</span>
                      {it}
                    </li>
                  ))}
                </ul>
                <a
                  href={user ? "#/account" : "#/register"}
                  className={`mt-6 block rounded-lg py-2.5 text-center font-sans text-sm font-medium transition ${
                    p.highlight
                      ? "bg-gold text-ink hover:bg-gold-deep"
                      : "border border-parchment/20 text-parchment-dim hover:border-gold/60 hover:text-gold"
                  }`}
                >
                  {p.cta}
                </a>
              </div>
            ))}
          </div>
          <p className="reveal mt-6 font-sans text-xs text-parchment-dim/60">
            Every new church starts with 14 days of Max, free. When a trial ends you
            keep the Free plan — a church never loses the ear.
          </p>
        </div>
      </section>

      {/* --------------------------------------------------- Closing CTA -- */}
      <section className="relative overflow-hidden border-t border-parchment/10 px-6 py-24 text-center">
        <div className="aurora aurora-drift" />
        <div className="reveal relative z-10 mx-auto max-w-2xl">
          <h2 className="font-display text-[clamp(1.9rem,4.5vw,3rem)] font-[440] leading-tight" style={{ textWrap: "balance" }}>
            Let your team watch the sermon, not the keyboard.
          </h2>
          <a
            href={cta}
            className="mt-9 inline-block rounded-lg bg-gold px-8 py-3.5 font-sans text-base font-medium text-ink shadow-lg shadow-gold/20 transition hover:-translate-y-0.5 hover:bg-gold-deep"
          >
            {user ? "Open the Studio →" : "Start 14 days free →"}
          </a>
        </div>
      </section>

      {/* -------------------------------------------------------- Footer -- */}
      <footer className="border-t border-parchment/10 px-6 py-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 text-center">
          <LogoMark size={30} />
          <p className="font-sans text-sm text-parchment-dim/70">
            The Word of God, on time.
          </p>
          <p className="font-sans text-xs text-parchment-dim/40">
            Emet (אמת) means Truth in Hebrew. Made with love in Rwanda.
          </p>
        </div>
      </footer>
    </main>
  )
}
