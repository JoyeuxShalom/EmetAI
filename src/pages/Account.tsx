// Account: subscription status, renewal (MoMo → admin approval), password.

import { useEffect, useState } from "react"
import { api, type Plan, type SessionInfo } from "../lib/api"
import { useAuth, hasActiveSubscription } from "../lib/auth"

const MOMO_CODE = "*182*8*1*XXXXXX#" // TODO: replace with your church MoMo pay code

function fmtDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

function fmtWhen(epoch: number) {
  const mins = Math.floor((Date.now() / 1000 - epoch) / 60)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`
  return fmtDate(epoch)
}

/** Turn a raw user-agent into something a pastor can recognise. */
function describeDevice(agent: string): string {
  if (!agent) return "Unknown device"
  const browser = /Edg\//.test(agent) ? "Edge"
    : /OPR\//.test(agent) ? "Opera"
    : /Firefox\//.test(agent) ? "Firefox"
    : /Chrome\//.test(agent) ? "Chrome"
    : /Safari\//.test(agent) ? "Safari"
    : "Browser"
  const os = /Windows/.test(agent) ? "Windows"
    : /Android/.test(agent) ? "Android"
    : /iPhone|iPad/.test(agent) ? "iPhone/iPad"
    : /Mac OS X/.test(agent) ? "Mac"
    : /Linux/.test(agent) ? "Linux"
    : ""
  return os ? `${browser} on ${os}` : browser
}

export default function Account() {
  const { user, refresh } = useAuth()
  const [plans, setPlans] = useState<Plan[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  const [period, setPeriod] = useState<"monthly" | "yearly">("monthly")
  const [payerRef, setPayerRef] = useState("")
  const [pending, setPending] = useState<{ plan: string; status: string } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Change password form
  const [curPw, setCurPw] = useState("")
  const [newPw, setNewPw] = useState("")
  const [pwMsg, setPwMsg] = useState<string | null>(null)

  // Two-factor authentication
  const [totpSetup, setTotpSetup] = useState<{ secret: string; otpauth: string } | null>(null)
  const [totpCode, setTotpCode] = useState("")
  const [totpMsg, setTotpMsg] = useState<string | null>(null)
  // Recovery codes: shown once, right after they are generated.
  const [showRecovery, setShowRecovery] = useState(false)
  const [recoveryPassword, setRecoveryPassword] = useState("")
  const [newCodes, setNewCodes] = useState<string[]>([])

  // Active sessions
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionMsg, setSessionMsg] = useState<string | null>(null)

  useEffect(() => {
    api.plans().then(setPlans).catch(() => {})
    api.myRequest().then((r) => {
      if (r && r.status === "pending") setPending(r)
    }).catch(() => {})
    api.sessions().then(setSessions).catch(() => {})
  }, [])

  if (!user) return null
  const active = hasActiveSubscription(user)
  const sub = user.subscription
  const chosenPrice = plans
    .flatMap((p) => Object.values(p.prices))
    .find((price) => price?.planId === chosen)?.priceUsd ?? 0
  const yearlyPercent = Math.max(0, ...plans.map((p) => p.yearlySavingPercent))

  async function makeRecoveryCodes(e: React.FormEvent) {
    e.preventDefault()
    setTotpMsg(null)
    try {
      const res = await api.regenerateRecoveryCodes(recoveryPassword)
      setNewCodes(res.codes)
      setRecoveryPassword("")
      await refresh()
    } catch (err) {
      setTotpMsg(err instanceof Error ? err.message : "Could not generate new codes.")
    }
  }

  async function chooseMethod(method: "email" | "totp") {
    setTotpMsg(null)
    try {
      await api.setTwoFactor(method)
      await refresh()
      setTotpMsg(
        method === "email"
          ? "Sign-in codes will be emailed to you ✓"
          : "Your authenticator app will provide sign-in codes ✓"
      )
    } catch (err) {
      setTotpMsg(err instanceof Error ? err.message : "Could not change the method.")
    }
  }

  async function signOutOthers() {
    setSessionMsg(null)
    try {
      const res = await api.revokeOtherSessions()
      setSessions(await api.sessions())
      setSessionMsg(
        res.revoked > 0
          ? `Signed out of ${res.revoked} other device${res.revoked === 1 ? "" : "s"}.`
          : "No other devices were signed in."
      )
    } catch (err) {
      setSessionMsg(err instanceof Error ? err.message : "Could not sign out the other devices.")
    }
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault()
    if (!chosen) return
    setError(null)
    try {
      const res = await api.requestSubscription(chosen, payerRef)
      setMessage(res.message)
      setPending({ plan: chosen, status: "pending" })
      setChosen(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit — try again.")
    }
  }

  async function startTotp() {
    setTotpMsg(null)
    try {
      setTotpSetup(await api.totpSetup())
    } catch (err) {
      setTotpMsg(err instanceof Error ? err.message : "Setup failed.")
    }
  }

  async function confirmTotp(e: React.FormEvent) {
    e.preventDefault()
    setTotpMsg(null)
    try {
      await api.totpEnable(totpCode)
      setTotpSetup(null)
      setTotpCode("")
      setTotpMsg("Two-factor authentication is ON ✓")
      await refresh()
    } catch (err) {
      setTotpMsg(err instanceof Error ? err.message : "Could not enable.")
    }
  }

  async function disableTotp(e: React.FormEvent) {
    e.preventDefault()
    setTotpMsg(null)
    try {
      await api.totpDisable(totpCode)
      setTotpCode("")
      setTotpMsg("Two-factor authentication is off.")
      await refresh()
    } catch (err) {
      setTotpMsg(err instanceof Error ? err.message : "Could not disable.")
    }
  }

  async function changePw(e: React.FormEvent) {
    e.preventDefault()
    setPwMsg(null)
    try {
      await api.changePassword(curPw, newPw)
      setPwMsg("Password changed ✓")
      setCurPw("")
      setNewPw("")
      await refresh()
    } catch (err) {
      setPwMsg(err instanceof Error ? err.message : "Could not change password.")
    }
  }

  const inputCls =
    "w-full rounded-lg border border-parchment/15 bg-ink px-3.5 py-2 font-sans text-sm text-parchment placeholder:text-parchment-dim/40 outline-none transition focus:border-gold/60"

  return (
    <main className="h-full overflow-y-auto bg-ink-soft px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-5">
        <h1 className="font-display text-2xl font-[440] text-parchment">Account</h1>

        {user.mustChangePassword && (
          <div className="rounded-xl border border-gold/50 bg-gold/10 p-4 font-sans text-sm text-gold">
            Security: change your first-time password below before doing anything else.
          </div>
        )}

        {/* Plan + usage */}
        <section className="rounded-2xl border border-parchment/10 bg-ink p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
                Your plan
              </p>
              {user.role === "admin" || user.role === "assistant" ? (
                <p className="mt-2 font-sans text-base text-mint">Staff — full access</p>
              ) : (
                <>
                  <p className="mt-2 font-display text-xl text-parchment">
                    {user.tierLabel}
                    {active && sub ? (
                      <span className="text-mint"> · active</span>
                    ) : (
                      <span className="text-parchment-dim"> · free for ever</span>
                    )}
                  </p>
                  <p className="mt-1 font-sans text-sm text-parchment-dim">
                    {active && sub
                      ? `Renew by ${fmtDate(sub.expiresAt)} (${sub.daysLeft} ${sub.daysLeft === 1 ? "day" : "days"} left)`
                      : "Manual scripture display is yours at no cost. Add AI whenever you're ready."}
                  </p>
                </>
              )}
            </div>
            <p className="font-sans text-sm text-parchment-dim/70">{user.church || user.name}</p>
          </div>

          {/* This month's allowance */}
          {user.tier !== "free" && user.role === "church" && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {([
                { name: "AI answers", q: user.quota.brainAsks },
                { name: "Sermon clips", q: user.quota.clips },
              ] as const).map(({ name, q }) => (
                <div key={name} className="rounded-xl border border-parchment/10 bg-ink-soft p-3">
                  <div className="flex items-baseline justify-between">
                    <p className="font-sans text-xs uppercase tracking-[0.2em] text-parchment-dim/60">
                      {name}
                    </p>
                    <p className="font-sans text-sm text-parchment">
                      {q.limit === null ? "unlimited" : `${q.used} / ${q.limit}`}
                    </p>
                  </div>
                  {q.limit !== null && (
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink">
                      <div
                        className={`h-full rounded-full ${
                          q.used >= q.limit ? "bg-rose" : "bg-gold/70"
                        }`}
                        style={{ width: `${Math.min(100, (q.used / Math.max(1, q.limit)) * 100)}%` }}
                      />
                    </div>
                  )}
                  <p className="mt-1.5 font-sans text-[0.7rem] text-parchment-dim/50">
                    {q.limit === null ? "No limit on your plan" : "Resets on the 1st of each month"}
                  </p>
                </div>
              ))}
            </div>
          )}

          {user.role === "church" && (
            <div className="mt-6 border-t border-parchment/10 pt-5">
              {pending ? (
                <div className="rounded-lg border border-sky/30 bg-sky/5 p-4">
                  <p className="font-sans text-sm text-sky">
                    Your <b>{pending.plan.replace("_", " ")}</b> payment is being verified — you'll
                    be activated shortly.
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-sans text-sm font-medium text-parchment">
                      {active ? "Change or extend your plan" : "Add AI to your services"}
                    </p>
                    {/* Monthly / yearly switch */}
                    <div className="flex rounded-lg border border-parchment/15 p-0.5">
                      {(["monthly", "yearly"] as const).map((p) => (
                        <button
                          key={p}
                          onClick={() => {
                            setPeriod(p)
                            setChosen(null)
                          }}
                          className={`rounded-md px-3 py-1 font-sans text-xs transition ${
                            period === p ? "bg-gold/15 text-gold" : "text-parchment-dim"
                          }`}
                        >
                          {p === "monthly" ? "Monthly" : `Yearly · save ${yearlyPercent}%`}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {plans.map((p) => {
                      const price = p.prices[period]
                      const isCurrent = p.tier === user.tier
                      const picked = price && chosen === price.planId
                      return (
                        <div
                          key={p.tier}
                          className={`flex flex-col rounded-xl border p-4 transition ${
                            picked
                              ? "border-gold/70 bg-gold/10"
                              : isCurrent
                                ? "border-mint/40 bg-mint/5"
                                : "border-parchment/15 bg-ink-soft"
                          }`}
                        >
                          <div className="flex items-baseline justify-between">
                            <p className="font-sans text-sm font-medium text-parchment">{p.label}</p>
                            {isCurrent && (
                              <span className="font-sans text-[0.65rem] uppercase tracking-wider text-mint">
                                current
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 font-sans text-xs text-parchment-dim/70">{p.tagline}</p>
                          <p className="mt-3 font-display text-2xl text-gold">
                            {price ? `$${price.priceUsd}` : "$0"}
                            <span className="ml-1 font-sans text-xs text-parchment-dim/60">
                              {price ? (period === "yearly" ? "/year" : "/month") : "for ever"}
                            </span>
                          </p>
                          {period === "yearly" && p.yearlySavingUsd > 0 && (
                            <p className="font-sans text-[0.7rem] text-mint">
                              save ${p.yearlySavingUsd} — {p.yearlySavingPercent}% off
                            </p>
                          )}
                          <ul className="mt-3 flex-1 space-y-1">
                            {p.features.map((f) => (
                              <li key={f} className="font-sans text-[0.72rem] leading-snug text-parchment-dim">
                                <span className="mr-1 text-mint">✓</span>
                                {f}
                              </li>
                            ))}
                            {p.missing.map((f) => (
                              <li key={f} className="font-sans text-[0.72rem] leading-snug text-parchment-dim/40">
                                <span className="mr-1">✕</span>
                                {f}
                              </li>
                            ))}
                          </ul>
                          {price ? (
                            <button
                              onClick={() => setChosen(picked ? null : price.planId)}
                              className={`mt-3 rounded-lg px-3 py-1.5 font-sans text-xs font-medium transition ${
                                picked
                                  ? "border border-gold/60 text-gold"
                                  : "bg-gold text-ink hover:bg-gold-deep"
                              }`}
                            >
                              {picked ? "Selected" : isCurrent ? "Extend" : `Choose ${p.label}`}
                            </button>
                          ) : (
                            <p className="mt-3 text-center font-sans text-xs text-parchment-dim/50">
                              Always included
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {chosen && (
                    <form onSubmit={submitRequest} className="mt-4 rounded-xl border border-parchment/10 bg-ink-soft p-4">
                      <p className="font-sans text-sm text-parchment">
                        1 · Pay <span className="text-gold">${chosenPrice}</span>{" "}
                        (or the RWF equivalent) with MTN Mobile Money:{" "}
                        <code className="rounded bg-ink px-2 py-0.5 text-gold">{MOMO_CODE}</code>
                      </p>
                      <p className="mt-2 font-sans text-sm text-parchment">
                        2 · Paste the transaction ID (or the phone number you paid from):
                      </p>
                      <input
                        value={payerRef}
                        onChange={(e) => setPayerRef(e.target.value)}
                        placeholder="e.g. TXN 8843… or 078xxxxxxx"
                        required
                        className={`mt-2 ${inputCls}`}
                      />
                      <button
                        type="submit"
                        className="mt-3 rounded-lg bg-gold px-4 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep"
                      >
                        Submit for activation →
                      </button>
                    </form>
                  )}
                  {message && <p className="mt-3 font-sans text-sm text-mint">{message}</p>}
                  {error && <p className="mt-3 font-sans text-sm text-rose">{error}</p>}
                </>
              )}
            </div>
          )}
        </section>

        {/* Two-factor authentication */}
        <section className="rounded-2xl border border-parchment/10 bg-ink p-6">
          <div className="flex items-center justify-between">
            <p className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
              Two-factor authentication
            </p>
            <span className="rounded-full border border-mint/40 px-2.5 py-0.5 font-sans text-xs text-mint">
              {user.twoFactor === "totp" ? "AUTH APP" : "EMAIL CODE"}
            </span>
          </div>

          <p className="mt-3 font-sans text-sm text-parchment-dim">
            Every sign-in needs a second proof, so a stolen password is not enough.
            This cannot be switched off — choose how you want to be asked:
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {([
              { id: "email", title: "Email code", note: "Sent to " + user.email },
              { id: "totp", title: "Authenticator app", note: user.totpEnabled ? "Ready" : "Needs setup" },
            ] as const).map((opt) => (
              <button
                key={opt.id}
                onClick={() => void chooseMethod(opt.id)}
                disabled={opt.id === "totp" && !user.totpEnabled}
                className={`rounded-lg border p-3 text-left transition disabled:opacity-40 ${
                  user.twoFactor === opt.id
                    ? "border-gold/60 bg-gold/10"
                    : "border-parchment/15 hover:border-parchment/30"
                }`}
              >
                <p className="font-sans text-sm text-parchment">{opt.title}</p>
                <p className="mt-0.5 font-sans text-xs text-parchment-dim/70">{opt.note}</p>
              </button>
            ))}
          </div>

          {/* Recovery codes — the reason requiring two-factor is safe. */}
          <div className="mt-4 rounded-lg border border-parchment/15 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-sans text-sm text-parchment">Recovery codes</p>
                <p className="mt-0.5 font-sans text-xs text-parchment-dim/70">
                  {user.recoveryCodesLeft > 0
                    ? `${user.recoveryCodesLeft} unused — each one signs you in once if you lose your phone.`
                    : "None left. Generate a set now, before you need one."}
                </p>
              </div>
              <button
                onClick={() => setShowRecovery((v) => !v)}
                className={`rounded-lg border px-3 py-1.5 font-sans text-xs transition ${
                  user.recoveryCodesLeft === 0
                    ? "border-rose/50 text-rose hover:bg-rose/10"
                    : "border-parchment/20 text-parchment-dim hover:border-gold/60 hover:text-gold"
                }`}
              >
                Generate new codes
              </button>
            </div>
            {showRecovery && newCodes.length === 0 && (
              <form onSubmit={makeRecoveryCodes} className="mt-3 flex flex-wrap gap-2">
                <input
                  type="password"
                  value={recoveryPassword}
                  onChange={(e) => setRecoveryPassword(e.target.value)}
                  placeholder="Confirm your password"
                  required
                  className={`${inputCls} max-w-64`}
                />
                <button
                  type="submit"
                  className="rounded-lg bg-gold px-4 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep"
                >
                  Generate
                </button>
                <p className="w-full font-sans text-xs text-parchment-dim/70">
                  Generating a new set immediately cancels the old one.
                </p>
              </form>
            )}
            {newCodes.length > 0 && (
              <div className="mt-3">
                <p className="font-sans text-xs text-gold">
                  Save these now — they are not shown again.
                </p>
                <ul className="mt-2 grid grid-cols-2 gap-1.5 rounded-lg bg-ink-soft p-3 sm:grid-cols-5">
                  {newCodes.map((c) => (
                    <li key={c} className="font-mono text-xs tracking-wider text-parchment">
                      {c}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void navigator.clipboard?.writeText(newCodes.join("\n"))}
                    className="rounded-lg border border-parchment/20 px-3 py-1.5 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => { setNewCodes([]); setShowRecovery(false) }}
                    className="rounded-lg border border-parchment/20 px-3 py-1.5 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>

          {!user.totpEnabled && !totpSetup && (
            <>
              <p className="mt-4 font-sans text-sm text-parchment-dim">
                An authenticator app (Google Authenticator, Microsoft Authenticator, Authy —
                all free) works without internet, which is useful in a hall with weak signal.
              </p>
              <button
                onClick={startTotp}
                className="mt-3 rounded-lg bg-gold px-4 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep"
              >
                Set up authenticator app →
              </button>
            </>
          )}

          {!user.totpEnabled && totpSetup && (
            <form onSubmit={confirmTotp} className="mt-4 space-y-3">
              <p className="font-sans text-sm text-parchment">
                1 · In your authenticator app choose <b>“Add account”</b> →{" "}
                <b>“Enter a setup key”</b> and type this key (account name: EmetAI):
              </p>
              <code className="block break-all rounded-lg bg-ink-soft px-3 py-2 font-mono text-sm tracking-wider text-gold">
                {totpSetup.secret}
              </code>
              <p className="font-sans text-sm text-parchment">
                2 · Enter the 6-digit code the app shows, to confirm:
              </p>
              <input
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="000000"
                required
                inputMode="numeric"
                maxLength={6}
                className={`${inputCls} max-w-40 text-center tracking-[0.4em]`}
              />
              <div className="flex gap-2">
                <button type="submit" className="rounded-lg bg-gold px-4 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep">
                  Confirm and use this app
                </button>
                <button
                  type="button"
                  onClick={() => { setTotpSetup(null); setTotpCode(""); }}
                  className="rounded-lg border border-parchment/20 px-4 py-2 font-sans text-sm text-parchment-dim hover:text-parchment"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {user.totpEnabled && (
            <form onSubmit={disableTotp} className="mt-4">
              <p className="font-sans text-sm text-parchment-dim">
                Your authenticator app is set up. To remove it (sign-in codes go back to
                email), enter a current code:
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="000000"
                  required
                  inputMode="numeric"
                  maxLength={6}
                  className={`${inputCls} max-w-40 text-center tracking-[0.4em]`}
                />
                <button type="submit" className="rounded-lg border border-rose/40 px-4 py-2 font-sans text-sm text-rose transition hover:bg-rose/10">
                  Remove app
                </button>
              </div>
            </form>
          )}
          {totpMsg && (
            <p className={`mt-3 font-sans text-sm ${totpMsg.includes("✓") ? "text-mint" : totpMsg.includes("off.") ? "text-parchment-dim" : "text-rose"}`}>
              {totpMsg}
            </p>
          )}
        </section>

        {/* Where you are signed in */}
        <section className="rounded-2xl border border-parchment/10 bg-ink p-6">
          <div className="flex items-center justify-between">
            <p className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
              Where you're signed in
            </p>
            {sessions.length > 1 && (
              <button
                onClick={() => void signOutOthers()}
                className="rounded-lg border border-rose/40 px-3 py-1.5 font-sans text-xs text-rose transition hover:bg-rose/10"
              >
                Sign out everywhere else
              </button>
            )}
          </div>
          <ul className="mt-3 space-y-2">
            {sessions.length === 0 && (
              <li className="font-sans text-sm text-parchment-dim/60">Loading…</li>
            )}
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink-soft px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-sans text-sm text-parchment">
                    {describeDevice(s.device)}
                    {s.current && <span className="ml-2 text-mint">· this device</span>}
                  </p>
                  <p className="font-sans text-xs text-parchment-dim/60">
                    {s.ip || "unknown address"} · last active {fmtWhen(s.lastSeenAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {sessionMsg && <p className="mt-3 font-sans text-sm text-mint">{sessionMsg}</p>}
        </section>

        {/* Password */}
        <section className="rounded-2xl border border-parchment/10 bg-ink p-6">
          <p className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
            Change password
          </p>
          <form onSubmit={changePw} className="mt-4 space-y-3">
            <input type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} placeholder="Current password" required className={inputCls} autoComplete="current-password" />
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password (10+ chars, upper, lower, number)" required className={inputCls} autoComplete="new-password" />
            <button type="submit" className="rounded-lg border border-parchment/20 px-4 py-2 font-sans text-sm text-parchment-dim transition hover:border-gold/60 hover:text-gold">
              Update password
            </button>
            {pwMsg && (
              <p className={`font-sans text-sm ${pwMsg.includes("✓") ? "text-mint" : "text-rose"}`}>{pwMsg}</p>
            )}
          </form>
        </section>

        <p className="pb-4 text-center font-sans text-xs text-parchment-dim/40">
          Signed in as {user.email}
        </p>
      </div>
    </main>
  )
}
