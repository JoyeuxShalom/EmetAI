// The EmetAI mark: an open book releasing a beam of light toward a single
// point of truth (emet, אמת), embraced by two "listening" arcs — the AI ear.

export function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="lg-beam" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#F5C451" stopOpacity="0.55" />
          <stop offset="1" stopColor="#F5C451" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lg-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F8D479" />
          <stop offset="1" stopColor="#E0A32E" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#070B14" />
      <polygon points="26,44 38,44 44,10 20,10" fill="url(#lg-beam)" />
      <circle cx="32" cy="11" r="2.6" fill="#F8D479" />
      <path d="M32 15 A 13 13 0 0 1 45 11" stroke="#F5C451" strokeOpacity="0.5" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M32 15 A 13 13 0 0 0 19 11" stroke="#F5C451" strokeOpacity="0.5" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M10 47 C 18 41.5, 27 41.5, 32 45.5 C 37 41.5, 46 41.5, 54 47 L 54 50.5 C 46 45.5, 37 45.5, 32 49.5 C 27 45.5, 18 45.5, 10 50.5 Z" fill="url(#lg-gold)" />
      <rect x="31" y="45" width="2" height="5.5" rx="1" fill="#070B14" />
    </svg>
  )
}

export default function Logo({ size = 32, wordmark = true }: { size?: number; wordmark?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 select-none">
      <LogoMark size={size} />
      {wordmark && (
        <span className="font-display text-xl tracking-wide text-parchment">
          Emet<span className="text-gold">AI</span>
        </span>
      )}
    </span>
  )
}
