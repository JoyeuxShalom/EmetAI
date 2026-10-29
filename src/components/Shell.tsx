// Slim app chrome for signed-in pages: logo, nav, subscription pill, sign out.

import Logo from "./Logo"
import { useAuth, hasActiveSubscription } from "../lib/auth"
import { useRoute } from "../lib/router"

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

  return (
    <div className="flex h-full flex-col bg-ink-soft">
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
                  : "border-rose/50 text-rose"
              }`}
              title="Subscription status"
            >
              {user.role === "admin"
                ? "Admin"
                : user.role === "assistant"
                  ? "Assistant"
                  : active && sub
                    ? `${sub.label} · ${sub.daysLeft}d left`
                    : "Expired"}
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
