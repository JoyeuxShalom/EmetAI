import { refOf, type Verse } from "../data/bible"
import type { BrainCard } from "../lib/api"

export type ProjectedItem = {
  verse: Verse | null
  label: string // translation name, shown under each block
}

const SIZES = [
  "text-[clamp(1.3rem,6.5vmin,5rem)]",
  "text-[clamp(1rem,4.4vmin,3.2rem)]",
  "text-[clamp(0.9rem,3.5vmin,2.4rem)]",
]

/** A definition / knowledge answer, projected full-screen. */
export function CardView({ card }: { card: BrainCard }) {
  const textAmount =
    card.body.join(" ").length + (card.points ?? []).join(" ").length
  const bodySize =
    textAmount > 700
      ? "text-[clamp(0.85rem,2.4vmin,1.6rem)]"
      : textAmount > 350
        ? "text-[clamp(0.95rem,3vmin,2rem)]"
        : "text-[clamp(1.05rem,3.6vmin,2.5rem)]"

  return (
    <div
      key={card.title}
      className="relative z-10 flex h-full flex-col items-center justify-center gap-1 px-[8vw] text-center"
    >
      <div className="animate-rise" style={{ animationDelay: "0.05s" }}>
        <p className="font-display font-[460] text-gold text-[clamp(1.6rem,6vmin,4.2rem)] leading-tight">
          {card.title}
        </p>
        {card.subtitle && (
          <p className="mt-2 font-sans uppercase tracking-[0.3em] text-sky/90 text-[clamp(0.7rem,1.6vmin,1.05rem)]">
            {card.subtitle}
          </p>
        )}
        <div className="mx-auto mt-4 h-px w-16 bg-gold/70" />
      </div>

      <div className="animate-rise mt-6 max-w-[62ch] space-y-4" style={{ animationDelay: "0.2s" }}>
        {card.body.map((p, i) => (
          <p
            key={i}
            className={`font-display font-[420] leading-[1.45] text-parchment ${bodySize}`}
            style={{ textWrap: "balance" }}
          >
            {p}
          </p>
        ))}
      </div>

      {(card.points?.length ?? 0) > 0 && (
        <ul
          className="animate-rise mt-6 max-w-[58ch] space-y-2 text-left"
          style={{ animationDelay: "0.35s" }}
        >
          {card.points!.map((pt, i) => (
            <li
              key={i}
              className="font-sans leading-snug text-parchment-dim text-[clamp(0.8rem,2.1vmin,1.3rem)]"
            >
              <span className="mr-2 text-gold">•</span>
              {pt}
            </li>
          ))}
        </ul>
      )}

      <p className="animate-rise mt-8 font-sans uppercase tracking-[0.3em] text-parchment-dim/55 text-[clamp(0.6rem,1vw,0.75rem)]" style={{ animationDelay: "0.45s" }}>
        {card.source}
      </p>
    </div>
  )
}

export default function ProjectionView({
  items,
  card,
}: {
  items: ProjectedItem[] | null
  card?: BrainCard | null
}) {
  if (card) {
    return (
      <main className="relative h-full w-full overflow-hidden bg-ink">
        <div className="beam animate-beam" />
        <CardView card={card} />
        <div className="vignette" />
      </main>
    )
  }
  const primary = items?.[0]?.verse ?? null
  const size = SIZES[Math.min((items?.length ?? 1) - 1, 2)]

  return (
    <main className="relative h-full w-full overflow-hidden bg-ink">
      <div className="beam animate-beam" />

      {items && primary ? (
        <div
          key={items.map((it) => (it.verse ? refOf(it.verse) : "x")).join("|")}
          className="relative z-10 flex h-full flex-col items-center justify-center gap-2 px-[7vw] text-center"
        >
          {/* Reference — from the primary version */}
          <div className="animate-rise" style={{ animationDelay: "0.05s" }}>
            <p className="font-sans text-sky/90 uppercase tracking-[0.35em] text-[clamp(0.75rem,1.5vw,1.05rem)]">
              {refOf(primary)}
            </p>
            <div className="mx-auto mt-3 h-px w-16 bg-gold/70" />
          </div>

          {items.map((item, i) => (
            <div
              key={item.label}
              className="animate-rise mt-6 w-full"
              style={{ animationDelay: `${0.18 + i * 0.14}s` }}
            >
              {item.verse ? (
                <p
                  className={`mx-auto max-w-[26ch] font-display font-[440] leading-[1.3] text-parchment ${size}`}
                  style={{ textWrap: "balance" }}
                >
                  {item.verse.text}
                </p>
              ) : (
                <p className="mx-auto font-sans text-parchment-dim/50 text-[clamp(0.8rem,1.6vmin,1rem)]">
                  — not available in this version —
                </p>
              )}
              <p className="mt-3 font-sans uppercase tracking-[0.3em] text-parchment-dim/55 text-[clamp(0.6rem,1vw,0.75rem)]">
                {item.label}
                {item.verse && refOf(item.verse) !== refOf(primary)
                  ? ` · ${item.verse.chapter}:${item.verse.verse}`
                  : ""}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="relative z-10 flex h-full items-center justify-center">
          <p className="animate-rise font-display font-[340] uppercase tracking-[0.5em] text-parchment-dim/40 text-[clamp(1rem,2.5vmin,1.6rem)]">
            EmetAI
          </p>
        </div>
      )}

      <div className="vignette" />
    </main>
  )
}