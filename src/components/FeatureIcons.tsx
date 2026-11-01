// The six marks on the "Built for a real service" cards.
//
// They replace emoji. Emoji are the wrong thing here for three reasons: they
// render as a different picture on every operating system, so the page a
// church sees is not the page we designed; they carry someone else's visual
// language into a brand built on one serif and one gold; and a grid of them
// reads as a placeholder a developer never got round to replacing.
//
// These are one system rather than six pictures. Every mark is drawn on the
// same 24-unit grid with the same 1.3 stroke, and each one carries a single
// filled gold dot standing for the same thing throughout — the moment a word
// lands. The eye picks the system up without being told.

type IconProps = { className?: string }

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
}

/** A voice radiating. The dot is the word; the arcs are the room. */
export function IconHears({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" className="text-gold" />
      <path d="M7.8 7.7a5 5 0 0 1 0 8.6" />
      <path d="M9.6 4.6a8.5 8.5 0 0 1 0 14.8" opacity="0.7" />
      <path d="M11.4 1.6a12 12 0 0 1 0 20.8" opacity="0.4" />
    </svg>
  )
}

/** Two different wordings arriving at one verse. */
export function IconParaphrase({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 5.5c5 1 8 3.5 10.5 6.5" />
      <path d="M3 18.5c5-1 8-3.5 10.5-6.5" opacity="0.6" />
      <circle cx="17.5" cy="12" r="3.2" opacity="0.45" />
      <circle cx="17.5" cy="12" r="1.5" fill="currentColor" stroke="none" className="text-gold" />
    </svg>
  )
}

/** Three translations standing together, the spoken one tallest. */
export function IconThreeUp({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <rect x="2.6" y="6.5" width="5" height="13" rx="1.1" opacity="0.55" />
      <rect x="9.5" y="3.5" width="5" height="16" rx="1.1" className="text-gold" />
      <rect x="16.4" y="6.5" width="5" height="13" rx="1.1" opacity="0.55" />
      <circle cx="12" cy="11.5" r="1.4" fill="currentColor" stroke="none" className="text-gold" />
    </svg>
  )
}

/** Turn about: one voice above the line, the other below it. */
export function IconInterpreter({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M2.5 12h19" opacity="0.3" />
      <path d="M4.5 9.5v-3M7.5 9.5v-5.5M10.5 9.5v-2.5" />
      <path d="M13.5 14.5v2.5M16.5 14.5v5.5M19.5 14.5v3" className="text-gold" opacity="0.85" />
    </svg>
  )
}

/** The book, and the answer arriving above it. */
export function IconAnswers({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M3 9.5c2.8-1.4 5.4-1.4 9 0 3.6-1.4 6.2-1.4 9 0v9.5c-2.8-1.4-5.4-1.4-9 0-3.6-1.4-6.2-1.4-9 0z" />
      <path d="M12 9.5V19" opacity="0.45" />
      <path d="M12 2.5v3.2M9.6 4.1l1.1 1.4M14.4 4.1l-1.1 1.4" className="text-gold" />
    </svg>
  )
}

/** A long service on a timeline, with one moment bracketed out of it.
 *  An earlier version stacked a filled panel above the timeline and the two
 *  shapes merged into something that read as a laptop. Trim handles say
 *  "choose this part of the sermon" without needing to be explained. */
export function IconClips({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M2.5 12h19" opacity="0.35" />
      <path d="M5 10v4M19 10v4" opacity="0.35" />
      <path d="M8.5 6.5v11M15.5 6.5v11" className="text-gold" />
      <path d="M8.5 6.5h2.2M8.5 17.5h2.2M15.5 6.5h-2.2M15.5 17.5h-2.2" className="text-gold" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" className="text-gold" />
    </svg>
  )
}
