// Slim app chrome for signed-in pages: logo, nav, subscription pill, sign out.

import Logo from "./Logo"
import { useAuth, hasActiveSubscription } from "../lib/auth"
import { useRoute } from "../lib/router"
import { useUpdateAvailable } from "../lib/version"

const NAV = [
  { to: "#/app", label: "Studio" },
  { to: "#/clips", label: "Clips" },
  { to: "#/learning", label: "Learning" },
  { to: "#/account", label: "Account" },
]

export default function Shell({ children }: { children: React.ReactNode }) {
  const { user, signOut } = useAuth()
  const route = useRoute()
  const sub = user?.subscription
  const active = hasActiveSubscription(user)
  // A tab left open through a deploy keeps running the old code, and a fix
  // that has shipped looks like a fix that does not work. Never reloads by
  // itself — a page that refreshes mid-sermon is worse than a stale one.
  const updateReady = useUpdateAvailable()

  return (
    <div className="flex h-full flex-col bg-ink-soft">
      {updateReady && (
        <button
          onClick={() => window.location.reload()}
          className="shrink-0 bg-gold px-4 py-1.5 text-center font-sans text-xs font-medium text-ink transition hover:bg-gold-deep"
        >
          A newer EmetAI is ready — click to reload. Your service keeps running
          until you do.
        </button>
      )}
      <nav className="flex h-12 shrink-0 items-center justify-between border-b border-parchment/10 bg-ink px-4">
        <div className="flex items-center gap-6">
          <a href="#/">
            <Logo size={26} />
          </a>
          <div className="flex items-center gap-1">
            {NAV.map((n) => (
              <a
                key={n.to}
                href={n.to}
                className={`rounded-md px-3 py-1.5 font-sans text-sm transition ${
                  route.startsWith(n.to)
                    ? "bg-gold/10 text-gold"
                    : "text-parchment-dim hover:text-parchment"
                }`}
              >
                {n.label}
              </a>
            ))}
            {(user?.role === "admin" || user?.role === "assistant") && (
              <a
                href="#/admin"
                className={`rounded-md px-3 py-1.5 font-sans text-sm transition ${
                  route.startsWith("#/admin")
                    ? "bg-gold/10 text-gold"
                    : "text-parchment-dim hover:text-parchment"
                }`}
              >
                {user.role === "admin" ? "Admin" : "Assistant"}
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {user && (
            <a
              href="#/account"
              className={`rounded-full border px-2.5 py-0.5 font-sans text-xs ${
                active
                  ? sub && sub.daysLeft <= 5
                    ? "border-gold/50 text-gold"
                    : "border-mint/40 text-mint"
                  : "border-parchment/20 text-parchment-dim"
              }`}
              title={
                active
                  ? "Subscription status"
                  : "Your plan — the AI ear is included for ever"
              }
            >
              {user.role === "admin"
                ? "Admin"
                : user.role === "assistant"
                  ? "Assistant"
                  : active && sub
                    ? `${sub.label} · ${sub.daysLeft}d left`
                    : // No subscription is not a lapsed account. The server
                      // puts a church with no plan on the free tier and keeps
                      // the ear switched on there, deliberately -- "a church
                      // never loses the Word itself". Calling that "Expired"
                      // in red told a church on the free plan, correctly
                      // signed in and able to project, that it was shut out.
                      user.tierLabel}
            </a>
          )}
          <span className="hidden font-sans text-xs text-parchment-dim/70 sm:block">
            {user?.church || user?.name}
          </span>
          <button
            onClick={signOut}
            className="rounded-md border border-parchment/15 px-2.5 py-1 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold"
          >
            Sign out
          </button>
        </div>
      </nav>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
