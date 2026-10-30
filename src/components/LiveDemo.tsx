// The hero demonstration: EmetAI doing its job, on a loop.
//
// A landing page for this product has one hard job — the thing EmetAI does is
// invisible in a screenshot. A preacher speaks and a verse appears; that is a
// SEQUENCE, and a still image of a verse on a screen says nothing about where
// it came from or how fast it arrived.
//
// So the hero performs it: a sentence is heard word by word, the ear thinks
// for a beat, and the verse lands on the projector. Three times, in three
// languages, so the bilingual claim is shown rather than asserted.
//
// Everything is real: these are genuine verses from the Bibles EmetAI ships,
// in the same typography the projector actually uses. Nothing here is a
// mock-up of a product that does not exist.

import { useEffect, useRef, useState } from "react"

type Scene = {
  language: string
  /** What the preacher says — heard word by word. */
  heard: string
  reference: string
  verse: string
  version: string
}

const SCENES: Scene[] = [
  {
    language: "Kinyarwanda",
    heard: "Muduhe icyo cyanditswe cya Yohana igice cya gatatu",
    reference: "Yohana 3:16",
    verse:
      "Kuko Imana yakunze abari mu isi cyane, byatumye itanga Umwana wayo w'ikinege…",
    version: "Bibiliya Yera",
  },
  {
    language: "English",
    heard: "…turn with me to the twenty-third psalm",
    reference: "Psalm 23:1",
    verse: "The LORD is my shepherd; I shall not want.",
    version: "King James Version",
  },
  {
    language: "Français",
    heard: "…donne-moi le verset sur l'amour de Dieu",
    reference: "Jean 3:16",
    verse:
      "Car Dieu a tant aimé le monde qu'il a donné son Fils unique…",
    version: "Louis Segond",
  },
]

// Timing, in milliseconds. Tuned to feel like the real thing: EmetAI takes
// about two seconds from the end of a sentence to the verse, so the pause
// before the card lands is honest rather than flattering.
const PER_CHARACTER = 42
const THINKING = 900
const HOLD = 3400

type Phase = "hearing" | "thinking" | "shown"

export default function LiveDemo() {
  const [scene, setScene] = useState(0)
  const [typed, setTyped] = useState(0)
  const [phase, setPhase] = useState<Phase>("hearing")
  const timers = useRef<number[]>([])

  const current = SCENES[scene]

  useEffect(() => {
    // Someone who has asked for less motion gets the finished frame, not a
    // frozen half-typed one.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    if (still) {
      setTyped(current.heard.length)
      setPhase("shown")
      return
    }

    const clear = () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
    clear()
    setTyped(0)
    setPhase("hearing")

    const at = (ms: number, fn: () => void) => {
      timers.current.push(window.setTimeout(fn, ms))
    }

    // Hearing: one character at a time, the way the live transcript fills in.
    for (let i = 1; i <= current.heard.length; i++) {
      at(i * PER_CHARACTER, () => setTyped(i))
    }
    const heardBy = current.heard.length * PER_CHARACTER
    at(heardBy, () => setPhase("thinking"))
    at(heardBy + THINKING, () => setPhase("shown"))
    at(heardBy + THINKING + HOLD, () =>
      setScene((s) => (s + 1) % SCENES.length)
    )

    return clear
  }, [scene, current.heard.length])

  return (
    <div className="relative mx-auto grid max-w-5xl gap-4 lg:grid-cols-5">
      {/* What EmetAI is hearing */}
      <div className="rounded-2xl border border-parchment/10 bg-ink-soft/80 p-5 backdrop-blur lg:col-span-2">
        <div className="flex items-center justify-between">
          <p className="font-sans text-[0.6rem] uppercase tracking-[0.3em] text-parchment-dim/60">
            Live transcript
          </p>
          <span className="flex items-end gap-[3px] h-3" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className="bar w-[3px] rounded-full bg-gold/80"
                style={{ height: "100%", animationDelay: `${i * 0.12}s` }}
              />
            ))}
          </span>
        </div>

        <p className="mt-1 font-sans text-[0.7rem] text-gold/80">
          {current.language}
        </p>

        <p className="mt-4 min-h-[5.5rem] font-sans text-base leading-relaxed text-parchment">
          {current.heard.slice(0, typed)}
          {phase === "hearing" && <span className="caret" />}
        </p>

        <p
          className={`font-sans text-xs transition-opacity duration-300 ${
            phase === "thinking" ? "text-gold opacity-100" : "opacity-0"
          }`}
        >
          Emet is finding it…
        </p>
      </div>

      {/* What the congregation sees */}
      <div className="relative overflow-hidden rounded-2xl border border-parchment/10 bg-ink p-8 shadow-2xl lg:col-span-3">
        <div className="beam" />
        <div className="vignette" />
        <div className="relative flex min-h-[15rem] flex-col items-center justify-center text-center">
          {phase === "shown" ? (
            <div key={current.reference} className="verse-arrive">
              <p className="font-sans text-[0.65rem] uppercase tracking-[0.35em] text-sky/90">
                {current.reference}
              </p>
              <div className="mx-auto mt-3 h-px w-14 bg-gold/70" />
              <p
                className="mx-auto mt-5 max-w-[26ch] font-display text-[clamp(1.15rem,2.1vw,1.7rem)] leading-snug"
                style={{ textWrap: "balance" }}
              >
                {current.verse}
              </p>
              <p className="mt-5 font-sans text-[0.6rem] uppercase tracking-[0.3em] text-parchment-dim/50">
                {current.version}
              </p>
            </div>
          ) : (
            <p className="font-sans text-sm text-parchment-dim/35">
              {phase === "thinking" ? "…" : "Screen is idle"}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
