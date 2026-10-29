// EmetAI landing — calm, modern, futuristic. Emet (אמת) = Truth.

import Logo, { LogoMark } from "../components/Logo"
import { useAuth } from "../lib/auth"

const FEATURES = [
  {
    title: "It hears Kinyarwanda",
    body: "A speech model fine-tuned for Kinyarwanda listens to the preacher — alongside English and French — and understands references like “Yohana 3:16” the moment they are spoken.",
    icon: "🎙",
  },
  {
    title: "Zero-delay display",
    body: "The verse appears on the projector the instant it is named. No typing, no searching, no awkward silence while the congregation waits.",
    icon: "⚡",
  },
  {
    title: "Catches paraphrased verses",
    body: "Even when the preacher quotes from memory without saying the reference, EmetAI recognizes which verse is being recited and stages it for you.",
    icon: "✨",
  },
  {
    title: "Verse mapping across versions",
    body: "Bibiliya Yera, KJV, Louis Segond and more — numbered differently, displayed correctly. EmetAI maps mismatched verse numbers between versions automatically.",
    icon: "🔀",
  },
  {
    title: "Three languages, side by side",
    body: "Project the same verse in Kinyarwanda, English and French at once — beautiful, legible typography built for projection screens.",
    icon: "🌍",
  },
  {
    title: "Sermon clips studio",
    body: "Paste a YouTube sermon link and EmetAI cuts the most powerful moments into caption-burned, social-ready clips — vertical for Reels, TikTok and Shorts.",
    icon: "🎬",
  },
]

const STEPS = [
  { n: "01", t: "Create your church account", b: "Sign up in one minute — every church starts with 14 days free." },
  { n: "02", t: "Open the Studio and the display", b: "The Studio runs on the operator's laptop; the display window goes to the projector." },
  { n: "03", t: "Press Listen — and preach", b: "EmetAI listens, finds, and projects every scripture as it is spoken." },
]

export default function Landing() {
  const { user } = useAuth()
  const cta = user ? "#/app" : "#/register"

  return (
    <main className="h-full overflow-y-auto bg-ink text-parchment">
      {/* Nav */}
      <nav className="sticky top-0 z-20 flex items-center justify-between border-b border-parchment/10 bg-ink/85 px-6 py-3 backdrop-blur">
        <Logo size={30} />
        <div className="flex items-center gap-2">
          <a href="#pricing" className="hidden rounded-md px-3 py-1.5 font-sans text-sm text-parchment-dim hover:text-parchment sm:block">
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

      {/* Hero */}
      <section className="relative overflow-hidden px-6 pb-24 pt-20 text-center">
        <div className="aurora" />
        <div className="relative z-10 mx-auto max-w-3xl">
          <p className="animate-rise font-sans text-xs uppercase tracking-[0.45em] text-gold/80">
            Emet · אמת · Truth
          </p>
          <h1
            className="animate-rise mt-5 font-display text-[clamp(2.2rem,6vw,4.2rem)] font-[440] leading-[1.12]"
            style={{ animationDelay: "0.08s", textWrap: "balance" }}
          >
            The scripture appears the moment it is <span className="text-gold">spoken</span>.
          </h1>
          <p
            className="animate-rise mx-auto mt-6 max-w-xl font-sans text-lg text-parchment-dim"
            style={{ animationDelay: "0.16s" }}
          >
            EmetAI listens to the preacher — in Kinyarwanda, English or French — and
            projects the exact verse instantly. Built for Rwandan churches.
          </p>
          <div className="animate-rise mt-9 flex items-center justify-center gap-3" style={{ animationDelay: "0.24s" }}>
            <a href={cta} className="rounded-lg bg-gold px-6 py-3 font-sans text-base font-medium text-ink shadow-lg shadow-gold/20 transition hover:bg-gold-deep">
              {user ? "Open the Studio →" : "Start 14 days free →"}
            </a>
            <a href="#how" className="rounded-lg border border-parchment/20 px-6 py-3 font-sans text-base text-parchment-dim transition hover:border-gold/60 hover:text-gold">
              How it works
            </a>
          </div>
          <p className="animate-rise mt-4 font-sans text-xs text-parchment-dim/50" style={{ animationDelay: "0.3s" }}>
            No credit card needed · Works offline during the service
          </p>
        </div>

        {/* Mini projection mock */}
        <div className="animate-rise relative z-10 mx-auto mt-16 max-w-2xl rounded-2xl border border-parchment/10 bg-ink-soft p-10 shadow-2xl" style={{ animationDelay: "0.36s" }}>
          <div className="beam" />
          <div className="relative">
            <p className="font-sans text-xs uppercase tracking-[0.35em] text-sky/90">Yohana 3:16</p>
            <div className="mx-auto mt-3 h-px w-14 bg-gold/70" />
            <p className="mx-auto mt-5 max-w-[30ch] font-display text-2xl leading-snug" style={{ textWrap: "balance" }}>
              Kuko Imana yakunze abari mu isi cyane, byatumye itanga Umwana wayo w'ikinege…
            </p>
            <p className="mt-4 font-sans text-[0.65rem] uppercase tracking-[0.3em] text-parchment-dim/50">
              Bibiliya Yera
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-parchment/10 px-6 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-center font-display text-3xl font-[440]">
            Everything a media team prays for
          </h2>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-xl border border-parchment/10 bg-ink-soft p-6 transition hover:border-gold/30">
                <p className="text-2xl">{f.icon}</p>
                <h3 className="mt-3 font-sans text-base font-semibold text-parchment">{f.title}</h3>
                <p className="mt-2 font-sans text-sm leading-relaxed text-parchment-dim">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-parchment/10 px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-center font-display text-3xl font-[440]">Three steps to Sunday</h2>
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="text-center">
                <p className="font-display text-4xl text-gold/70">{s.n}</p>
                <h3 className="mt-3 font-sans text-base font-semibold">{s.t}</h3>
                <p className="mt-2 font-sans text-sm text-parchment-dim">{s.b}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-parchment/10 px-6 py-20">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="font-display text-3xl font-[440]">Simple pricing for every church</h2>
          <p className="mt-3 font-sans text-parchment-dim">
            The AI ear is free for ever — every church hears the preacher. Add AI answers and
            clips when you're ready, monthly or 12.5% cheaper by the year, with MTN Mobile Money.
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
                per: "per month · or $210 a year (save 12.5%)",
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
                per: "per month · or $420 a year (save 12.5%)",
                items: [
                  "Everything in Pro",
                  "Unlimited AI answers",
                  "Unlimited sermon clips",
                  "Priority support",
                ],
                cta: "Choose Max",
                highlight: false,
              },
            ].map((p) => (
              <div
                key={p.name}
                className={`rounded-2xl border p-7 text-left ${
                  p.highlight ? "border-gold/60 bg-gold/5 shadow-lg shadow-gold/10" : "border-parchment/10 bg-ink-soft"
                }`}
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
          <p className="mt-6 font-sans text-xs text-parchment-dim/60">
            Every new church starts with 14 days of Max, free. When a trial or subscription ends
            you keep the Free plan — a church never loses the AI ear or the scriptures.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-parchment/10 px-6 py-10">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-3 text-center">
          <LogoMark size={30} />
          <p className="font-sans text-sm text-parchment-dim/70">
            EmetAI — Ijambo ry'Imana, ku mwanya. · The Word of God, on time.
          </p>
          <p className="font-sans text-xs text-parchment-dim/40">
            Emet (אמת) means Truth in Hebrew. Made with love in Rwanda.
          </p>
        </div>
      </footer>
    </main>
  )
}
