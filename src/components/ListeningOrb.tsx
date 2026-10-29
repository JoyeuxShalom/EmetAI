// The face of the AI while it is listening.
//
// Four states, each with its own motion, so the operator can read what EmetAI
// is doing from across a dark room without looking at any text:
//
//   idle      still, dim, waiting to be switched on
//   listening slow breathing — the microphone is open
//   hearing   the rings swell with the preacher's actual voice
//   thinking  a bright arc sweeps while an answer is being fetched
//
// The gradient is EmetAI's own: gold through sky into violet, never a generic
// rainbow. Everything is CSS and SVG — no images, no libraries, and it keeps
// running smoothly on the modest laptops churches actually use.

export type OrbState = "idle" | "listening" | "hearing" | "thinking"

export default function ListeningOrb({
  state,
  level = 0,
  size = 26,
}: {
  state: OrbState
  /** Live microphone loudness, 0–1. Drives the swell when state is "hearing". */
  level?: number
  size?: number
}) {
  const active = state !== "idle"
  // Voice pushes the rings outward; a gentle floor keeps it alive when quiet.
  const swell = state === "hearing" ? 0.55 + Math.min(1, level) * 0.75 : 0.55

  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width={size} height={size} className="overflow-visible">
        <defs>
          {/* The core: gold at the heart, cooling to violet at the rim. */}
          <radialGradient id="orbCore" cx="38%" cy="34%" r="72%">
            <stop offset="0%" stopColor="#FFF3D0" />
            <stop offset="34%" stopColor="#F5C451" />
            <stop offset="68%" stopColor="#6FA8FF" />
            <stop offset="100%" stopColor="#8B5CF6" />
          </radialGradient>
          <linearGradient id="orbSweep" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#F5C451" stopOpacity="0" />
            <stop offset="50%" stopColor="#F5C451" />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
          </linearGradient>
          <filter id="orbGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Outer halo — breathes with the room's voice */}
        <circle
          cx="50" cy="50" r="46"
          fill="url(#orbCore)"
          opacity={active ? 0.16 * swell : 0.06}
          className={active ? "orb-halo" : ""}
          style={{ transform: `scale(${active ? swell : 0.8})`, transformOrigin: "50% 50%" }}
        />
        <circle
          cx="50" cy="50" r="34"
          fill="url(#orbCore)"
          opacity={active ? 0.3 * swell : 0.1}
          className={active ? "orb-halo orb-halo-delayed" : ""}
          style={{
            transform: `scale(${active ? 0.85 + swell * 0.25 : 0.8})`,
            transformOrigin: "50% 50%",
          }}
        />

        {/* The core itself */}
        <circle
          cx="50" cy="50" r="22"
          fill="url(#orbCore)"
          filter={active ? "url(#orbGlow)" : undefined}
          opacity={active ? 1 : 0.42}
          className={state === "listening" || state === "hearing" ? "orb-core" : ""}
          style={{
            transform: `scale(${state === "hearing" ? 0.92 + Math.min(1, level) * 0.3 : 1})`,
            transformOrigin: "50% 50%",
            transition: "transform 90ms ease-out",
          }}
        />

        {/* Thinking: a bright arc travelling round the rim */}
        {state === "thinking" && (
          <circle
            cx="50" cy="50" r="38"
            fill="none"
            stroke="url(#orbSweep)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray="60 180"
            className="orb-sweep"
          />
        )}
      </svg>
    </span>
  )
}

/** The same orb, large and centred — used where the ear has room to breathe. */
export function ListeningBanner({
  state,
  level,
  title,
  detail,
}: {
  state: OrbState
  level: number
  title: string
  detail?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-parchment/10 bg-ink-soft/60 px-3 py-2.5">
      <ListeningOrb state={state} level={level} size={34} />
      <div className="min-w-0">
        <p className="font-sans text-xs font-medium text-parchment">{title}</p>
        {detail && (
          <p className="truncate font-sans text-[0.7rem] text-parchment-dim/70">{detail}</p>
        )}
      </div>
      {/* A small live meter, so a silent microphone is obvious at a glance. */}
      {(state === "hearing" || state === "listening") && (
        <div className="ml-auto flex items-end gap-[3px]" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-gold/70"
              style={{
                height: `${6 + Math.min(1, level) * 16 * [0.5, 0.85, 1, 0.8, 0.55][i]}px`,
                transition: "height 90ms ease-out",
                opacity: state === "hearing" ? 1 : 0.35,
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
