// Sign in / create account — one calm card that walks through every step:
// password → emailed code → in. Plus email confirmation and password recovery.

import { useEffect, useRef, useState } from "react"
import Logo from "../components/Logo"
import { api, type AuthStep } from "../lib/api"
import { useAuth } from "../lib/auth"
import { navigate } from "../lib/router"

type Stage =
  | "credentials"
  | "challenge"
  | "forgot"
  | "reset"
  // Two-factor is required of every account, so an account that has none is
  // walked through setting one up before it is let in. These are those steps.
  | "enrollChoose"
  | "enrollProve"
  | "recoveryCodes"

export default function Auth({ mode }: { mode: "login" | "register" }) {
  const { signIn, register, completeChallenge, completeEnrollment, adoptSession } = useAuth()
  const isRegister = mode === "register"

  const [stage, setStage] = useState<Stage>("credentials")
  const [name, setName] = useState("")
  const [church, setChurch] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [remember, setRemember] = useState(true)

  // What the server is waiting for, between the two steps.
  const [challenge, setChallenge] = useState("")
  const [kind, setKind] = useState<"verify" | "2fa">("2fa")
  const [method, setMethod] = useState<"email" | "totp">("email")

  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const codeRef = useRef<HTMLInputElement>(null)

  // Enrolment: the authenticator secret being set up, and the recovery codes
  // that are shown exactly once when it succeeds.
  const [enrollMethod, setEnrollMethod] = useState<"email" | "totp">("totp")
  const [secret, setSecret] = useState("")
  const [qr, setQr] = useState("")
  const [emailDeliverable, setEmailDeliverable] = useState(true)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [savedCodes, setSavedCodes] = useState(false)
  // The finished session, held back until the codes have been written down.
  const [pendingSession, setPendingSession] = useState<AuthStep | null>(null)

  useEffect(() => {
    if (stage === "challenge") codeRef.current?.focus()
  }, [stage])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  /** Route whatever the server returned to the right next screen. */
  function handleStep(step: AuthStep) {
    if (step.token) {
      if (step.warning) {
        // Signed in, but something about the security step needs saying.
        setNotice(step.warning)
        setTimeout(() => navigate("#/app"), 2500)
        return
      }
      navigate("#/app")
      return
    }
    if (step.needsVerification) {
      setKind("verify")
      setMethod("email")
      setChallenge(step.challenge ?? "")
      setNotice(
        step.notice ??
          `We sent a 6-digit code to ${step.email ?? email}. Enter it to confirm your email.`
      )
      setStage("challenge")
      setCooldown(45)
      return
    }
    if (step.needsEnrollment) {
      setChallenge(step.challenge ?? "")
      setEmailDeliverable(step.emailDeliverable !== false)
      setEnrollMethod("totp")
      setNotice(null)
      setStage("enrollChoose")
      return
    }
    if (step.requires2fa) {
      setKind("2fa")
      setMethod(step.method === "totp" ? "totp" : "email")
      setChallenge(step.challenge ?? "")
      setNotice(
        step.notice ??
          (step.method === "totp"
            ? "Enter the 6-digit code from your authenticator app."
            : `We sent a 6-digit sign-in code to ${email}.`)
      )
      setStage("challenge")
      setCooldown(45)
      return
    }
    setError("Unexpected response from the server — please try again.")
  }

  /** Ask the server to begin enrolment with the chosen factor. */
  async function startEnrollment(chosen: "email" | "totp") {
    setError(null)
    setNotice(null)
    setBusy(true)
    setEnrollMethod(chosen)
    try {
      const res = await api.enrollStart(challenge, chosen)
      if (chosen === "totp" && res.secret) {
        setSecret(res.secret)
        // Typing a 32-character key into a phone is a real barrier for a
        // volunteer on a Sunday, so offer the QR code first.
        const { toDataURL } = await import("qrcode")
        setQr(
          await toDataURL(res.otpauth ?? "", {
            margin: 1,
            width: 220,
            color: { dark: "#0b0b0f", light: "#f5efe3" },
          })
        )
      }
      if (res.notice) setNotice(res.notice)
      if (chosen === "email") setCooldown(45)
      setStage("enrollProve")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the setup.")
    } finally {
      setBusy(false)
    }
  }

  async function submitEnrollment(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const step = await completeEnrollment({
        challenge,
        method: enrollMethod,
        code,
        rememberDevice: remember,
      })
      setCode("")
      setRecoveryCodes(step.recoveryCodes ?? [])
      setPendingSession(step)
      setSavedCodes(false)
      setStage("recoveryCodes")
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work.")
      setCode("")
      codeRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      handleStep(isRegister ? await register({ name, church, email, password }) : await signIn(email, password))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.")
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const step = await completeChallenge(kind, challenge, code, remember)
      setCode("")
      // Confirming an email may hand back an enrolment step rather than a
      // session — a new church still has to choose a second factor.
      if (step.needsEnrollment) handleStep(step)
      else navigate("#/app")
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work.")
      setCode("")
      codeRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setError(null)
    try {
      const res = await api.resendCode(challenge, kind)
      setNotice(res.notice ?? "A new code is on its way.")
      setCooldown(45)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send another code.")
    }
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await api.forgotPassword(email)
      setNotice(res.message)
      setStage("reset")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the reset.")
    } finally {
      setBusy(false)
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await api.resetPassword({ email, code, password })
      setNotice(res.message)
      setStage("credentials")
      setCode("")
      setPassword("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset the password.")
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    "w-full rounded-lg border border-parchment/15 bg-ink px-4 py-2.5 font-sans text-base text-parchment placeholder:text-parchment-dim/40 outline-none transition focus:border-gold/60"
  const codeCls = `${inputCls} text-center tracking-[0.4em]`
  const buttonCls =
    "w-full rounded-lg bg-gold py-2.5 font-sans text-base font-medium text-ink transition hover:bg-gold-deep disabled:opacity-50"

  const heading =
    stage === "challenge"
      ? kind === "verify"
        ? "Confirm your email"
        : "Two-step verification"
      : stage === "enrollChoose"
        ? "Protect this account"
        : stage === "enrollProve"
          ? enrollMethod === "totp"
            ? "Scan this with your phone"
            : "Check your inbox"
          : stage === "recoveryCodes"
            ? "Save your recovery codes"
            : stage === "forgot"
              ? "Reset your password"
              : stage === "reset"
                ? "Choose a new password"
                : isRegister
                  ? "Create your church account"
                  : "Welcome back"

  const subheading =
    stage === "challenge"
      ? method === "totp"
        ? "Open your authenticator app for the code."
        : "Check your inbox — the code expires in 10 minutes."
      : stage === "enrollChoose"
        ? "EmetAI asks for a second step at sign-in. Choose how you would like to be asked."
        : stage === "enrollProve"
          ? enrollMethod === "totp"
            ? "Then type the 6-digit code your app shows."
            : "Enter the 6-digit code we just sent you."
          : stage === "recoveryCodes"
            ? "These get you back in if you lose your phone. You will not see them again."
            : stage === "forgot"
              ? "We'll email you a code to set a new password."
              : stage === "reset"
                ? "Enter the code we emailed, then your new password."
                : isRegister
                  ? "14 days free — no card needed."
                  : "Sign in to open your Studio."

  return (
    <main className="relative flex h-full items-center justify-center overflow-y-auto bg-ink px-4 py-10">
      <div className="aurora" />
      <div className="relative z-10 w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <a href="#/">
            <Logo size={38} />
          </a>
        </div>
        <div className="animate-rise rounded-2xl border border-parchment/10 bg-ink-soft p-7 shadow-2xl">
          <h1 className="font-display text-2xl font-[440] text-parchment">{heading}</h1>
          <p className="mt-1.5 font-sans text-sm text-parchment-dim">{subheading}</p>

          {stage === "credentials" && (
            <form onSubmit={submitCredentials} className="mt-6 space-y-3.5">
              {isRegister && (
                <>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required className={inputCls} autoComplete="name" />
                  <input value={church} onChange={(e) => setChurch(e.target.value)} placeholder="Church name (e.g. Zion Temple Kigali)" className={inputCls} autoComplete="organization" />
                </>
              )}
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required className={inputCls} autoComplete="email" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isRegister ? "Password (10+ chars, upper, lower, number)" : "Password"}
                required
                className={inputCls}
                autoComplete={isRegister ? "new-password" : "current-password"}
              />
              {error && <p className="font-sans text-sm text-rose">{error}</p>}
              {notice && <p className="font-sans text-sm text-sky">{notice}</p>}
              <button type="submit" disabled={busy} className={buttonCls}>
                {busy ? "One moment…" : isRegister ? "Start free →" : "Sign in →"}
              </button>
              {!isRegister && (
                <button
                  type="button"
                  onClick={() => {
                    setStage("forgot")
                    setError(null)
                    setNotice(null)
                  }}
                  className="w-full font-sans text-sm text-parchment-dim transition hover:text-gold"
                >
                  Forgot your password?
                </button>
              )}
            </form>
          )}

          {stage === "challenge" && (
            <form onSubmit={submitCode} className="mt-6 space-y-3.5">
              {notice && (
                <p className="rounded-lg border border-gold/30 bg-gold/5 p-3 font-sans text-sm text-gold/90">
                  {notice}
                </p>
              )}
              {/* A recovery code is accepted here too, so the field cannot be
                  digits-only — that is the way back in when the phone is lost
                  or the email never arrives. */}
              <input
                ref={codeRef}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 12))
                }
                placeholder={kind === "2fa" ? "000000  or  a recovery code" : "000000"}
                required
                autoComplete="one-time-code"
                maxLength={12}
                className={codeCls}
              />
              <label className="flex cursor-pointer items-center gap-2 font-sans text-sm text-parchment-dim">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 accent-[#F5C451]"
                />
                Trust this computer for 30 days
              </label>
              {error && <p className="font-sans text-sm text-rose">{error}</p>}
              <button type="submit" disabled={busy || code.trim().length < 6} className={buttonCls}>
                {busy ? "Checking…" : "Verify →"}
              </button>
              <div className="flex items-center justify-between">
                {method === "email" ? (
                  <button
                    type="button"
                    onClick={resend}
                    disabled={cooldown > 0}
                    className="font-sans text-sm text-parchment-dim transition hover:text-gold disabled:opacity-40"
                  >
                    {cooldown > 0 ? `Send another code (${cooldown}s)` : "Send another code"}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setStage("credentials")
                    setCode("")
                    setError(null)
                    setNotice(null)
                  }}
                  className="font-sans text-sm text-parchment-dim transition hover:text-gold"
                >
                  Start over
                </button>
              </div>
            </form>
          )}

          {stage === "enrollChoose" && (
            <div className="mt-6 space-y-3">
              <p className="rounded-lg border border-gold/30 bg-gold/5 p-3 font-sans text-sm text-gold/90">
                Your password was accepted. One more step protects this account
                even if that password is ever guessed or stolen.
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void startEnrollment("totp")}
                className="w-full rounded-lg border border-gold/50 bg-gold/5 p-4 text-left transition hover:border-gold disabled:opacity-50"
              >
                <p className="font-sans text-base font-medium text-gold">
                  Authenticator app
                  <span className="ml-2 rounded bg-gold/15 px-1.5 py-0.5 text-[0.65rem] uppercase tracking-widest">
                    Recommended
                  </span>
                </p>
                <p className="mt-1 font-sans text-sm text-parchment-dim">
                  Google Authenticator, Authy or Microsoft Authenticator on your
                  phone. Works with no internet and no email — the code is always
                  there when you need it.
                </p>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void startEnrollment("email")}
                className="w-full rounded-lg border border-parchment/15 p-4 text-left transition hover:border-gold/60 disabled:opacity-50"
              >
                <p className="font-sans text-base font-medium text-parchment">Emailed code</p>
                <p className="mt-1 font-sans text-sm text-parchment-dim">
                  We send six digits to {email || "your address"} each time you sign in.
                  {!emailDeliverable &&
                    " Email is not connected on this server yet, so this will not work today."}
                </p>
              </button>
              {error && <p className="font-sans text-sm text-rose">{error}</p>}
            </div>
          )}

          {stage === "enrollProve" && (
            <form onSubmit={submitEnrollment} className="mt-6 space-y-3.5">
              {notice && (
                <p className="rounded-lg border border-rose/40 bg-rose/5 p-3 font-sans text-sm text-rose">
                  {notice}
                </p>
              )}
              {enrollMethod === "totp" && (
                <div className="rounded-lg border border-parchment/15 bg-ink p-4 text-center">
                  {qr && (
                    <img
                      src={qr}
                      alt="Scan this code with your authenticator app"
                      className="mx-auto rounded-md"
                      width={220}
                      height={220}
                    />
                  )}
                  <p className="mt-3 font-sans text-xs text-parchment-dim">
                    Can't scan? Type this key into the app instead:
                  </p>
                  <code className="mt-1 block break-all font-mono text-sm tracking-wider text-gold">
                    {secret.replace(/(.{4})/g, "$1 ").trim()}
                  </code>
                </div>
              )}
              <input
                ref={codeRef}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className={codeCls}
              />
              <label className="flex cursor-pointer items-center gap-2 font-sans text-sm text-parchment-dim">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 accent-[#F5C451]"
                />
                Trust this computer for 30 days
              </label>
              {error && <p className="font-sans text-sm text-rose">{error}</p>}
              <button type="submit" disabled={busy || code.length !== 6} className={buttonCls}>
                {busy ? "Checking…" : "Turn on protection →"}
              </button>
              <div className="flex items-center justify-between">
                {enrollMethod === "email" ? (
                  <button
                    type="button"
                    onClick={() => void startEnrollment("email")}
                    disabled={cooldown > 0}
                    className="font-sans text-sm text-parchment-dim transition hover:text-gold disabled:opacity-40"
                  >
                    {cooldown > 0 ? `Send another code (${cooldown}s)` : "Send another code"}
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setStage("enrollChoose")
                    setCode("")
                    setError(null)
                    setNotice(null)
                  }}
                  className="font-sans text-sm text-parchment-dim transition hover:text-gold"
                >
                  Choose a different way
                </button>
              </div>
            </form>
          )}

          {stage === "recoveryCodes" && (
            <div className="mt-6 space-y-3.5">
              <p className="rounded-lg border border-gold/30 bg-gold/5 p-3 font-sans text-sm text-gold/90">
                Two-step protection is on. Print these codes or write them down and
                keep them somewhere safe — each one signs you in once if you lose
                your {enrollMethod === "totp" ? "phone" : "access to email"}.
              </p>
              <ul className="grid grid-cols-2 gap-2 rounded-lg border border-parchment/15 bg-ink p-4">
                {recoveryCodes.map((c) => (
                  <li key={c} className="font-mono text-sm tracking-wider text-parchment">
                    {c}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(recoveryCodes.join("\n"))}
                  className="flex-1 rounded-lg border border-parchment/15 py-2 font-sans text-sm text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="flex-1 rounded-lg border border-parchment/15 py-2 font-sans text-sm text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                >
                  Print
                </button>
              </div>
              <label className="flex cursor-pointer items-start gap-2 font-sans text-sm text-parchment-dim">
                <input
                  type="checkbox"
                  checked={savedCodes}
                  onChange={(e) => setSavedCodes(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[#F5C451]"
                />
                I have saved these codes somewhere safe.
              </label>
              <button
                type="button"
                disabled={!savedCodes}
                onClick={() => {
                  // Only now is the session taken up: signing in any earlier
                  // sends the router to the Studio and these codes are gone.
                  if (pendingSession) adoptSession(pendingSession)
                  navigate("#/app")
                }}
                className={buttonCls}
              >
                Open my Studio →
              </button>
            </div>
          )}

          {stage === "forgot" && (
            <form onSubmit={submitForgot} className="mt-6 space-y-3.5">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your account email" required className={inputCls} autoComplete="email" />
              {error && <p className="font-sans text-sm text-rose">{error}</p>}
              <button type="submit" disabled={busy} className={buttonCls}>
                {busy ? "Sending…" : "Send reset code →"}
              </button>
              <button
                type="button"
                onClick={() => setStage("credentials")}
                className="w-full font-sans text-sm text-parchment-dim transition hover:text-gold"
              >
                Back to sign in
              </button>
            </form>
          )}

          {stage === "reset" && (
            <form onSubmit={submitReset} className="mt-6 space-y-3.5">
              {notice && (
                <p className="rounded-lg border border-gold/30 bg-gold/5 p-3 font-sans text-sm text-gold/90">
                  {notice}
                </p>
              )}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6-digit code"
                required
                inputMode="numeric"
                maxLength={6}
                className={codeCls}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="New password (10+ chars, upper, lower, number)"
                required
                className={inputCls}
                autoComplete="new-password"
              />
              {error && <p className="font-sans text-sm text-rose">{error}</p>}
              <button type="submit" disabled={busy} className={buttonCls}>
                {busy ? "Saving…" : "Set new password →"}
              </button>
              <button
                type="button"
                onClick={() => setStage("credentials")}
                className="w-full font-sans text-sm text-parchment-dim transition hover:text-gold"
              >
                Back to sign in
              </button>
            </form>
          )}

          {stage === "credentials" && (
            <p className="mt-5 text-center font-sans text-sm text-parchment-dim">
              {isRegister ? (
                <>Already have an account? <a href="#/login" className="text-gold hover:underline">Sign in</a></>
              ) : (
                <>New church? <a href="#/register" className="text-gold hover:underline">Start free</a></>
              )}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}
