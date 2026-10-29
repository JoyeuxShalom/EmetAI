// Auth state: current user, the two-step sign-in, subscription awareness.
//
// Signing in is a conversation, not a single call:
//   login()            → either a session, or a challenge for the 2nd factor
//   completeChallenge()→ exchanges the emailed code for a real session
// Whichever step returns a token is the one that signs the user in.

import { createContext, useCallback, useContext, useEffect, useState } from "react"
import {
  api,
  getToken,
  setToken,
  setDeviceToken,
  type AuthStep,
  type User,
} from "./api"

type AuthState = {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<AuthStep>
  register: (body: {
    name: string
    church: string
    email: string
    password: string
  }) => Promise<AuthStep>
  /** Finish a pending challenge with the 6-digit code. */
  completeChallenge: (
    kind: "verify" | "2fa",
    challenge: string,
    code: string,
    rememberDevice: boolean
  ) => Promise<AuthStep>
  /** Finish setting up a second factor, which completes the sign-in too. */
  completeEnrollment: (body: {
    challenge: string
    method: "email" | "totp"
    code: string
    rememberDevice: boolean
  }) => Promise<AuthStep>
  /** Take up a session that was held back — used once recovery codes are saved. */
  adoptSession: (step: AuthStep) => void
  signOut: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null)
      setLoading(false)
      return
    }
    try {
      setUser(await api.me())
    } catch {
      setToken(null) // the session was revoked or expired server-side
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Store whatever a completed step handed back. */
  function adopt(step: AuthStep): User | null {
    if (!step.token || !step.user) return null
    setToken(step.token)
    if (step.deviceToken) setDeviceToken(step.deviceToken)
    setUser(step.user)
    return step.user
  }

  async function signIn(email: string, password: string) {
    const step = await api.login({ email, password })
    adopt(step)
    // A sign-in that skipped the second factor must not pass unnoticed.
    if (step.warning) sessionStorage.setItem("emetai_signin_warning", step.warning)
    return step
  }

  async function register(body: {
    name: string
    church: string
    email: string
    password: string
  }) {
    const step = await api.register(body)
    adopt(step)
    return step
  }

  async function completeChallenge(
    kind: "verify" | "2fa",
    challenge: string,
    code: string,
    rememberDevice: boolean
  ) {
    const step =
      kind === "verify"
        ? await api.verifyEmail({ challenge, code, rememberDevice })
        : await api.verify2fa({ challenge, code, rememberDevice })
    // Confirming an email no longer signs you in on its own — a brand-new
    // account still has to choose a second factor. The caller routes it.
    adopt(step)
    if (step.warning) sessionStorage.setItem("emetai_signin_warning", step.warning)
    if (!step.token && !step.needsEnrollment) {
      throw new Error("Sign-in did not complete — please try again.")
    }
    return step
  }

  /** Finish setting up a second factor.
   *
   *  The session is deliberately NOT adopted here. Adopting it signs the user
   *  in, and the router sends a signed-in visitor straight from /login to the
   *  Studio — which would scroll the recovery codes past them before they
   *  could write any down. The caller adopts once the codes are acknowledged. */
  async function completeEnrollment(body: {
    challenge: string
    method: "email" | "totp"
    code: string
    rememberDevice: boolean
  }) {
    const step = await api.enrollComplete(body)
    if (!step.token || !step.user) throw new Error("Setup did not complete — please try again.")
    return step
  }

  function signOut() {
    void api.logout().catch(() => {}) // best effort: kill the session server-side
    setToken(null)
    setUser(null)
    window.location.hash = "#/"
  }

  return (
    <AuthContext.Provider
      value={{
        user, loading, signIn, register,
        completeChallenge, completeEnrollment,
        adoptSession: (step: AuthStep) => void adopt(step),
        signOut, refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth outside AuthProvider")
  return ctx
}

export function hasActiveSubscription(user: User | null): boolean {
  if (!user) return false
  if (user.role === "admin" || user.role === "assistant") return true
  return user.subscription !== null && user.subscription.expiresAt * 1000 > Date.now()
}

/** AI answers (definitions, history) are a paid feature; the ear is not. */
export function canAskAI(user: User | null): boolean {
  if (!user) return false
  return user.quota.brainAsks.limit !== 0
}

export function can(user: User | null, permission: string): boolean {
  if (!user) return false
  if (user.role === "admin") return true
  return (user.permissions ?? []).includes(permission)
}
