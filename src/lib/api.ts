// EmetAI API client — thin fetch wrapper over the backend (proxied at /api).

const TOKEN_KEY = "emetai_token"
const DEVICE_KEY = "emetai_device" // proves this browser already passed 2FA

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export function getDeviceToken(): string {
  return localStorage.getItem(DEVICE_KEY) ?? ""
}

export function setDeviceToken(token: string | null) {
  if (token) localStorage.setItem(DEVICE_KEY, token)
  else localStorage.removeItem(DEVICE_KEY)
}

export type Subscription = {
  plan: string
  label: string
  period: string
  expiresAt: number
  daysLeft: number
} | null

export type Tier = "free" | "pro" | "max"

/** null limit = unlimited. */
export type Quota = { used: number; limit: number | null }

export type PlanCard = {
  tier: Tier
  label: string
  tagline: string
  features: string[]
  missing: string[]
  ai: boolean
  brainAsks: number | null
  clips: number | null
  prices: Partial<Record<"monthly" | "yearly", { planId: string; priceUsd: number; days: number }>>
  yearlySavingUsd: number
  yearlySavingPercent: number
}

export type MyPlan = {
  tier: Tier
  label: string
  ai: boolean
  brainAsks: Quota
  clips: Quota
}

export type Role = "church" | "assistant" | "admin"

export type User = {
  id: string
  email: string
  name: string
  church: string
  role: Role
  tier: Tier
  tierLabel: string
  ai: boolean
  quota: { brainAsks: Quota; clips: Quota }
  permissions: string[]
  mustChangePassword: boolean
  emailVerified: boolean
  twoFactor: "email" | "totp"
  /** Always true — every EmetAI account has a second factor. */
  twoFactorEnabled: boolean
  totpEnabled: boolean
  recoveryCodesLeft: number
  subscription: Subscription
}

/** The server's answer to a sign-in or registration attempt. */
export type AuthStep = {
  token?: string
  user?: User
  deviceToken?: string
  requires2fa?: boolean
  needsVerification?: boolean
  /** No second factor on this account yet — it must be set up before entry. */
  needsEnrollment?: boolean
  method?: "email" | "totp"
  challenge?: string
  email?: string
  name?: string
  emailSent?: boolean
  emailDeliverable?: boolean
  recoveryLeft?: number
  /** Shown once, at enrolment. The server keeps only hashes. */
  recoveryCodes?: string[]
  notice?: string | null
  warning?: string
}

export type SessionInfo = {
  id: string
  ip: string
  device: string
  createdAt: number
  lastSeenAt: number
  current: boolean
}

export type Assistant = {
  id: string
  email: string
  name: string
  permissions: string[]
  status: string
  createdAt: number
  lastSeenAt: number
}

export type PermissionInfo = { id: string; label: string; adminOnly: boolean }

export type ReportsOverview = {
  churches: number
  verifiedChurches: number
  activeSubscriptions: number
  trials: number
  expiringThisWeek: number
  pendingRequests: number
  clipJobs: number
  activeToday: number
  activeThisWeek: number
  activeThisMonth: number
  newChurchesThisMonth: number
  retentionRate: number | null
  retentionCohort: number
  series: { day: string; users: number; events: number }[]
  features: { event: string; label: string; count: number; churches: number }[]
  engine: string
}

export type ChurchActivity = {
  id: string
  email: string
  name: string
  church: string
  createdAt: number
  lastSeenAt: number
  emailVerified: boolean
  status: string
  activeDays: number
  totalEvents: number
  versesShown: number
  voiceCommands: number
  aiQuestions: number
  listeningSessions: number
  subscription: { plan: string; expiresAt: number } | null
}

export type AuditEntry = {
  id: string
  actor: string
  action: string
  target: string
  detail: string
  ip: string
  createdAt: number
}

export type AdminSession = {
  id: string
  email: string
  name: string
  church: string
  role: string
  ip: string
  device: string
  createdAt: number
  lastSeenAt: number
}

export type Plan = PlanCard

export type ClipInfo = {
  index: number
  start: number
  end: number
  duration: number
  title: string
  score: number
  file: string
}

export type ClipJob = {
  id: string
  url: string
  status: string
  progress: string
  error: string
  params: { clip_seconds: number; count: number; format: string; language: string; mode?: string }
  clips: ClipInfo[]
  createdAt: number
}

export type CaptionLine = { start: number; end: number; text: string }

export type BrainCard = {
  title: string
  subtitle?: string
  body: string[]
  points?: string[]
  source: string
}

/** What the agent is allowed to ask the Studio to do. Anything outside this
 *  union is refused by the executor — the planner proposes, it does not act. */
export type AgentAction =
  | { type: "versions"; ids: string[] }
  | { type: "verses"; refs: string[] }
  | { type: "control"; action: string }
  | { type: "answer"; query: string; mode: "general" | "spiritual"; depth: "brief" | "full" }

export type AgentPlan = {
  /** One short line for the operator, in the language the preacher spoke. */
  say: string
  actions: AgentAction[]
}

export type BrainAsk = {
  q: string
  kind?: string
  scope?: string
  lang?: string
  /** 'general' keeps it short and factual; 'spiritual' gives theology room. */
  mode?: "general" | "spiritual" | "auto"
  depth?: "brief" | "full"
  /** Keeps the thread, so "say more" and "and in Greek?" mean something. */
  conversationId?: string
  /** "Go back to what you said about grace" — answer from what was already said. */
  recall?: boolean
}

/** One field of the answer, carrying its text IN FULL each time — never a
 *  delta — so a dropped event cannot corrupt what is on the screen. */
export type BrainSlot = {
  type: "slot"
  slot: "title" | "subtitle" | "body" | "point"
  index: number
  text: string
  done: boolean
}

export type BrainEvent =
  | { type: "open"; conversationId: string }
  | BrainSlot
  | { type: "done"; card: BrainCard; conversationId: string; topic: string; recalled?: boolean }
  | { type: "error"; message: string }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** One service — a Sunday, a revival night — under which everything heard is
 *  filed, so it can be reviewed afterwards as a unit. */
export type ServiceRecord = {
  id: string
  title: string
  ear: string
  started_at: number
  ended_at: number
  lines: number
  corrections: number
}

export type ServiceLineIn = {
  seq: number
  heard: string
  lang?: string
  /** detected | projected | command | answer | ignored */
  action: string
  result?: string
  score?: number
  /** Who said it — "preacher", "interpreter", "speaker 1/2", or "both". */
  speaker?: string
}

export type ServiceLine = ServiceLineIn & { id: string; created_at: number }

/** A word EmetAI has been taught, or a mishearing it has been taught to fix. */
export type LexiconTerm = {
  id: string
  kind: "term" | "alias"
  heard: string
  correct: string
  lang: string
  weight: number
  source: string
  created_at: number
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers["Authorization"] = `Bearer ${token}`
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) setToken(null) // stale session — force re-login
    throw new ApiError(res.status, errorMessage(data, res.status))
  }
  return data as T
}

/** Turn any error body into a sentence. A bare status code tells nobody what
 *  went wrong — and a field-validation body arrives as a list of objects. */
function errorMessage(data: unknown, status: number): string {
  const detail = (data as { detail?: unknown } | null)?.detail
  if (typeof detail === "string" && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        const e = item as { loc?: unknown[]; msg?: string }
        const field = (e.loc ?? []).filter((p) => p !== "body" && p !== "query").join(".")
        return field ? `${field}: ${e.msg ?? "is invalid"}` : (e.msg ?? "")
      })
      .filter(Boolean)
    if (parts.length) return parts.slice(0, 3).join("; ")
  }
  return `Request failed (${status})`
}

/** The answer as it is written, rather than after it is finished.
 *
 *  EventSource cannot carry an Authorization header, so this reads the
 *  server-sent events off a normal fetch. Abort the signal to walk away from
 *  an answer that is no longer wanted — the socket is released either way. */
async function* brainStream(
  body: BrainAsk,
  signal?: AbortSignal
): AsyncGenerator<BrainEvent> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  }
  const token = getToken()
  if (token) headers["Authorization"] = `Bearer ${token}`

  const res = await fetch("/api/brain/stream", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    if (res.status === 401) setToken(null)
    throw new ApiError(res.status, errorMessage(data, res.status))
  }
  if (!res.body) throw new ApiError(500, "This browser cannot stream the answer.")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Events are separated by a blank line; a half-arrived one waits.
      let cut = buffer.indexOf("\n\n")
      for (; cut !== -1; cut = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          try {
            yield JSON.parse(payload) as BrainEvent
          } catch {
            /* a truncated frame is not worth failing the whole answer over */
          }
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}

export const api = {
  register: (body: { name: string; church: string; email: string; password: string }) =>
    request<AuthStep>("POST", "/api/auth/register", body),
  login: (body: { email: string; password: string }) =>
    request<AuthStep>("POST", "/api/auth/login", { ...body, deviceToken: getDeviceToken() }),
  verifyEmail: (body: { challenge: string; code: string; rememberDevice?: boolean }) =>
    request<AuthStep>("POST", "/api/auth/verify-email", body),
  verify2fa: (body: { challenge: string; code: string; rememberDevice?: boolean }) =>
    request<AuthStep>("POST", "/api/auth/2fa/verify", body),
  resendCode: (challenge: string, purpose: "2fa" | "verify") =>
    request<{ ok: boolean; emailSent: boolean; notice: string | null }>(
      "POST", "/api/auth/resend-code", { challenge, purpose }
    ),
  forgotPassword: (email: string) =>
    request<{ ok: boolean; message: string }>("POST", "/api/auth/forgot-password", { email }),
  resetPassword: (body: { email: string; code: string; password: string }) =>
    request<{ ok: boolean; message: string }>("POST", "/api/auth/reset-password", body),
  logout: () => request<{ ok: boolean }>("POST", "/api/auth/logout"),

  me: () => request<User>("GET", "/api/me"),
  changePassword: (current: string, next: string) =>
    request<{ ok: boolean; message?: string }>("POST", "/api/auth/change-password", {
      current,
      new: next,
    }),
  sessions: () => request<SessionInfo[]>("GET", "/api/auth/sessions"),
  revokeOtherSessions: () =>
    request<{ ok: boolean; revoked: number }>("POST", "/api/auth/sessions/revoke-others"),
  // Two-factor cannot be switched off — the only choice is which factor.
  setTwoFactor: (method: "email" | "totp") =>
    request<{ ok: boolean; method: string }>("POST", "/api/auth/2fa/method", { method }),
  totpSetup: () => request<{ secret: string; otpauth: string }>("POST", "/api/auth/2fa/setup"),
  totpEnable: (code: string) => request<{ ok: boolean }>("POST", "/api/auth/2fa/enable", { code }),
  totpDisable: (code: string) => request<{ ok: boolean }>("POST", "/api/auth/2fa/disable", { code }),
  regenerateRecoveryCodes: (password: string) =>
    request<{ ok: boolean; codes: string[] }>("POST", "/api/auth/2fa/recovery", { password }),

  // Enrolment: reached with the password accepted but no session yet.
  enrollStart: (challenge: string, method: "email" | "totp") =>
    request<{
      method: string
      secret?: string
      otpauth?: string
      emailSent?: boolean
      notice?: string | null
    }>("POST", "/api/auth/2fa/enroll/start", { challenge, method }),
  enrollComplete: (body: {
    challenge: string
    method: "email" | "totp"
    code: string
    rememberDevice?: boolean
  }) => request<AuthStep>("POST", "/api/auth/2fa/enroll/complete", body),

  reportUsage: (events: string[], detail = "") =>
    request<{ ok: boolean }>("POST", "/api/usage", { events, detail }),

  plans: () => request<PlanCard[]>("GET", "/api/plans"),
  myPlan: () => request<MyPlan>("GET", "/api/my-plan"),
  requestSubscription: (plan: string, payerRef: string) =>
    request<{ ok: boolean; message: string }>("POST", "/api/subscriptions/request", {
      plan,
      payerRef,
    }),
  myRequest: () =>
    request<{ plan: string; status: string; created_at: number } | null>(
      "GET",
      "/api/subscriptions/my-request"
    ),

  adminStats: () =>
    request<{ users: number; activeSubscriptions: number; pendingRequests: number; clipJobs: number }>(
      "GET",
      "/api/admin/stats"
    ),
  adminUsers: (q: string) =>
    request<
      {
        id: string
        email: string
        name: string
        church: string
        createdAt: number
        subscription: { plan: string; expiresAt: number } | null
      }[]
    >("GET", `/api/admin/users?q=${encodeURIComponent(q)}`),
  adminGrant: (userId: string, plan: string) =>
    request<{ ok: boolean }>("POST", "/api/admin/subscriptions/grant", { userId, plan }),
  adminRevoke: (userId: string) =>
    request<{ ok: boolean }>("POST", "/api/admin/subscriptions/revoke", { userId }),
  adminRequests: () =>
    request<
      {
        id: string
        user_id: string
        plan: string
        payer_ref: string
        created_at: number
        email: string
        name: string
        church: string
      }[]
    >("GET", "/api/admin/requests"),
  adminResolve: (id: string, approve: boolean) =>
    request<{ ok: boolean }>("POST", `/api/admin/requests/${id}/resolve`, { approve }),
  adminSetUserStatus: (userId: string, status: "active" | "suspended") =>
    request<{ ok: boolean }>("POST", "/api/admin/users/status", { userId, status }),

  // Assistants
  assistants: () => request<Assistant[]>("GET", "/api/admin/assistants"),
  permissionList: () => request<PermissionInfo[]>("GET", "/api/admin/permissions"),
  createAssistant: (body: { email: string; name: string; permissions: string[] }) =>
    request<{ ok: boolean; emailSent: boolean; temporaryPassword: string | null; notice: string | null }>(
      "POST", "/api/admin/assistants", body
    ),
  updateAssistant: (id: string, body: { permissions?: string[]; status?: string }) =>
    request<{ ok: boolean }>("POST", `/api/admin/assistants/${id}`, body),
  deleteAssistant: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/api/admin/assistants/${id}`),

  // Reports
  reportsOverview: () => request<ReportsOverview>("GET", "/api/admin/reports/overview"),
  reportsChurches: (q = "", sort = "activity") =>
    request<ChurchActivity[]>(
      "GET", `/api/admin/reports/churches?q=${encodeURIComponent(q)}&sort=${sort}`
    ),
  auditLog: (q = "", limit = 100) =>
    request<AuditEntry[]>("GET", `/api/admin/audit?q=${encodeURIComponent(q)}&limit=${limit}`),
  adminSessions: () => request<AdminSession[]>("GET", "/api/admin/sessions"),
  adminRevokeSession: (body: { sessionId?: string; userId?: string }) =>
    request<{ ok: boolean }>("POST", "/api/admin/sessions/revoke", body),

  // Email delivery
  emailStatus: () =>
    request<{
      provider: string
      configured: boolean
      keyHint: string
      from: string
      providers: {
        id: string
        label: string
        keyHint: string
        where: string
        note: string
        configured: boolean
      }[]
    }>("GET", "/api/admin/email/status"),
  /** `clear` disconnects the provider. Saving with an empty key and
   *  clear=false keeps the stored key and updates only the sender. */
  setEmailKey: (
    key: string,
    fromAddress: string,
    provider: string,
    clear = false
  ) =>
    request<{
      ok: boolean
      configured: boolean
      provider: string
      warning: string | null
      message: string | null
    }>("POST", "/api/admin/email/key", { key, fromAddress, provider, clear }),
  sendTestEmail: (to: string) =>
    request<{ ok: boolean }>("POST", "/api/admin/email/test", { to }),

  brainAsk: (body: BrainAsk) =>
    request<{ card: BrainCard; cached?: boolean }>("POST", "/api/brain/ask", body),
  brainStream,
  brainConversation: (id: string) =>
    request<{
      id: string
      topics: { topic: string; at: number; seq: number }[]
      turns: { role: string; content: string }[]
    }>("GET", `/api/brain/conversation/${encodeURIComponent(id)}`),
  brainEndConversation: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/api/brain/conversation/${encodeURIComponent(id)}`),
  brainStatus: () =>
    request<{
      lexicon: boolean
      claude: boolean
      keyHint: string
      model: string
      sdk: boolean
      gemini: boolean
      geminiHint: string
      geminiModel: string
      streaming: boolean
    }>("GET", "/api/brain/status"),
  brainSetKey: (key: string, provider: "claude" | "gemini" = "claude") =>
    request<{ ok: boolean; claude: boolean; gemini: boolean }>("POST", "/api/brain/key", {
      key,
      provider,
    }),
  // The voice assistant's master switch, and the planner behind it.
  voiceStatus: () =>
    request<{ enabled: boolean; canToggle: boolean; agent: boolean }>(
      "GET", "/api/voice/status"
    ),
  voiceToggle: (enabled: boolean) =>
    request<{ ok: boolean; enabled: boolean }>("POST", "/api/voice/toggle", { enabled }),
  voicePlan: (body: {
    transcript: string
    showing?: string
    versions?: string[]
    lang?: string
  }) => request<AgentPlan>("POST", "/api/voice/plan", body),

  brainSetModel: (model: string) =>
    request<{ ok: boolean; model: string }>("POST", "/api/brain/model", { model }),

  createClipJob: (body: {
    url: string
    clipSeconds: number
    count: number
    format: string
    language: string
    mode: string
  }) => request<{ id: string }>("POST", "/api/clips/jobs", body),
  clipJobs: () => request<ClipJob[]>("GET", "/api/clips/jobs"),
  clipJob: (id: string) => request<ClipJob>("GET", `/api/clips/jobs/${id}`),
  deleteClipJob: (id: string) => request<{ ok: boolean }>("DELETE", `/api/clips/jobs/${id}`),
  clipTranscript: (id: string) => request<CaptionLine[]>("GET", `/api/clips/jobs/${id}/transcript`),
  editClip: (id: string, index: number, body: { start: number; end: number; captions: CaptionLine[] }) =>
    request<{ ok: boolean }>("POST", `/api/clips/jobs/${id}/clips/${index}/edit`, body),

  // —— Learning: the record of a service, and what it taught EmetAI ——
  startService: (body: { title: string; ear: string }) =>
    request<{ id: string }>("POST", "/api/learning/service", body),
  logServiceLine: (id: string, body: ServiceLineIn) =>
    request<{ ok: boolean }>("POST", `/api/learning/service/${id}/line`, body),
  endService: (id: string) =>
    request<{ ok: boolean }>("POST", `/api/learning/service/${id}/end`),
  services: () => request<{ services: ServiceRecord[] }>("GET", "/api/learning/services"),
  service: (id: string) =>
    request<{ service: ServiceRecord; lines: ServiceLine[] }>("GET", `/api/learning/service/${id}`),
  deleteService: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/api/learning/service/${id}`),
  teachCorrection: (body: {
    heard: string
    correct: string
    lang?: string
    service_id?: string
  }) => request<{ ok: boolean; learned: string[] }>("POST", "/api/learning/correction", body),
  lexicon: () =>
    request<{ terms: LexiconTerm[]; shipped: number; hint: string }>(
      "GET",
      "/api/learning/lexicon"
    ),
  addTerm: (body: { correct: string; lang?: string }) =>
    request<{ ok: boolean; added: boolean }>("POST", "/api/learning/term", body),
  deleteTerm: (id: string) =>
    request<{ ok: boolean }>("DELETE", `/api/learning/term/${id}`),
}

export function clipFileUrl(jobId: string, file: string): string {
  return `/api/clips/jobs/${jobId}/file/${file}?token=${encodeURIComponent(getToken() ?? "")}`
}
