// Admin dashboard: stats, pending payment approvals, church management.

import { useCallback, useEffect, useState } from "react"
import { AssistantsPanel, EmailPanel, ReportsPanel, SecurityPanel } from "../components/AdminPanels"
import { api } from "../lib/api"
import { can, useAuth } from "../lib/auth"

type Tab = "churches" | "reports" | "assistants" | "security" | "settings"

type Stats = { users: number; activeSubscriptions: number; pendingRequests: number; clipJobs: number }
type Row = {
  id: string
  email: string
  name: string
  church: string
  createdAt: number
  subscription: { plan: string; expiresAt: number } | null
}
type PayReq = {
  id: string
  plan: string
  payer_ref: string
  created_at: number
  email: string
  name: string
  church: string
}

function fmtDate(epoch: number) {
  return new Date(epoch * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

export default function Admin() {
  const { user } = useAuth()
  const isAdmin = user?.role === "admin"
  const [tab, setTab] = useState<Tab>("churches")
  const [stats, setStats] = useState<Stats | null>(null)
  const [users, setUsers] = useState<Row[]>([])
  const [requests, setRequests] = useState<PayReq[]>([])
  const [q, setQ] = useState("")
  const [error, setError] = useState<string | null>(null)

  // The voice assistant's master switch.
  const [voiceOn, setVoiceOn] = useState(false)
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null)

  // Emet brain (AI answers) settings
  const [brain, setBrain] = useState<{
    claude: boolean
    keyHint: string
    model: string
    sdk: boolean
    gemini: boolean
    geminiHint: string
    geminiModel: string
  } | null>(null)
  const [keyInput, setKeyInput] = useState("")
  const [geminiInput, setGeminiInput] = useState("")
  const [brainMsg, setBrainMsg] = useState<string | null>(null)

  const reload = useCallback(async (query = "") => {
    // An assistant may hold only some of these powers — load each on its own
    // so one refusal doesn't blank the whole page.
    const [s, u, r] = await Promise.all([
      api.adminStats().catch(() => null),
      api.adminUsers(query).catch(() => null),
      api.adminRequests().catch(() => null),
    ])
    if (s) setStats(s)
    if (u) setUsers(u)
    if (r) setRequests(r)
    setError(s || u || r ? null : "You do not have permission to view this.")
  }, [])

  useEffect(() => {
    void reload()
    if (isAdmin) api.brainStatus().then(setBrain).catch(() => setBrain(null))
    void api.voiceStatus().then((s) => setVoiceOn(s.enabled)).catch(() => {})
  }, [reload, isAdmin])

  async function saveBrainKey(key: string, provider: "claude" | "gemini") {
    setBrainMsg(null)
    try {
      await api.brainSetKey(key, provider)
      if (provider === "gemini") setGeminiInput("")
      else setKeyInput("")
      setBrain(await api.brainStatus())
      const name = provider === "gemini" ? "Gemini" : "Claude"
      setBrainMsg(key ? `${name} connected — Emet now answers with AI.` : `${name} key removed.`)
    } catch (e) {
      setBrainMsg(e instanceof Error ? e.message : "Could not save the key.")
    }
  }

  async function toggleVoice(next: boolean) {
    setVoiceMsg(null)
    try {
      const res = await api.voiceToggle(next)
      setVoiceOn(res.enabled)
      setVoiceMsg(
        res.enabled
          ? "Voice assistant is on. Studios can open the microphone."
          : "Voice assistant is off. Every microphone is closed and the agent is dormant."
      )
    } catch (e) {
      setVoiceMsg(e instanceof Error ? e.message : "Could not change the switch.")
    }
  }

  async function saveBrainModel(model: string) {
    setBrainMsg(null)
    try {
      await api.brainSetModel(model)
      setBrain(await api.brainStatus())
      setBrainMsg(`Emet now answers with ${model}.`)
    } catch (e) {
      setBrainMsg(e instanceof Error ? e.message : "Could not change the model.")
    }
  }

  useEffect(() => {
    const t = setTimeout(() => void reload(q), 250)
    return () => clearTimeout(t)
  }, [q, reload])

  async function grant(userId: string, plan: string) {
    await api.adminGrant(userId, plan)
    await reload(q)
  }

  async function revoke(userId: string) {
    if (!window.confirm("Revoke this church's access immediately?")) return
    await api.adminRevoke(userId)
    await reload(q)
  }

  async function resolve(id: string, approve: boolean) {
    await api.adminResolve(id, approve)
    await reload(q)
  }

  const cards = stats
    ? [
        { label: "Churches", value: stats.users },
        { label: "Active subscriptions", value: stats.activeSubscriptions },
        { label: "Pending payments", value: stats.pendingRequests },
        { label: "Clip jobs", value: stats.clipJobs },
      ]
    : []

  return (
    <main className="h-full overflow-y-auto bg-ink-soft px-4 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-[440] text-parchment">
            {isAdmin ? "Admin dashboard" : "Assistant dashboard"}
          </h1>
          {!isAdmin && (
            <span className="rounded-full border border-sky/40 px-3 py-1 font-sans text-xs text-sky">
              Assistant · limited access
            </span>
          )}
        </div>

        {/* Tabs */}
        <nav className="flex flex-wrap gap-1.5 border-b border-parchment/10 pb-3">
          {([
            { id: "churches", label: "Churches", show: true },
            { id: "reports", label: "Reports", show: can(user, "reports.view") },
            { id: "assistants", label: "Assistants", show: isAdmin },
            { id: "security", label: "Security", show: isAdmin || can(user, "audit.view") },
            { id: "settings", label: "Settings", show: isAdmin },
          ] as const)
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id as Tab)}
                className={`rounded-lg px-3.5 py-1.5 font-sans text-sm transition ${
                  tab === t.id
                    ? "bg-gold/15 text-gold"
                    : "text-parchment-dim hover:text-parchment"
                }`}
              >
                {t.label}
              </button>
            ))}
        </nav>

        {error && <p className="font-sans text-sm text-rose">{error}</p>}

        {tab === "reports" && <ReportsPanel />}
        {tab === "assistants" && <AssistantsPanel />}
        {tab === "security" && <SecurityPanel isAdmin={isAdmin} />}
        {tab === "settings" && <EmailPanel />}

        {tab === "churches" && (
        <>
        {/* Stats */}
        <div className="grid gap-4 sm:grid-cols-4">
          {cards.map((c) => (
            <div key={c.label} className="rounded-xl border border-parchment/10 bg-ink p-5">
              <p className="font-display text-3xl text-gold">{c.value}</p>
              <p className="mt-1 font-sans text-xs uppercase tracking-[0.2em] text-parchment-dim/60">
                {c.label}
              </p>
            </div>
          ))}
        </div>

        </>
        )}

        {/* The master switch for the whole voice pipeline. */}
        {tab === "settings" && (
        <section className="rounded-2xl border border-parchment/10 bg-ink p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-sans text-sm font-medium text-parchment">
                Voice assistant · master switch
              </p>
              <p className="mt-1 max-w-2xl font-sans text-xs text-parchment-dim/70">
                While this is off, no microphone opens, no speech is transcribed and the
                agent is never consulted — for every church on this installation. The
                server refuses the connection itself, so turning it off is a real stop,
                not a hidden button.
              </p>
            </div>
            <button
              onClick={() => void toggleVoice(!voiceOn)}
              className={`shrink-0 rounded-lg border px-4 py-2 font-sans text-sm transition ${
                voiceOn
                  ? "border-mint/50 bg-mint/10 text-mint hover:border-mint"
                  : "border-parchment/20 text-parchment-dim hover:border-gold/60 hover:text-gold"
              }`}
            >
              {voiceOn ? "● Voice assistant ON" : "○ Voice assistant OFF"}
            </button>
          </div>
          {voiceMsg && <p className="mt-2 font-sans text-xs text-sky">{voiceMsg}</p>}
        </section>
        )}

        {/* Emet brain — AI answers (administrator only) */}
        {tab === "settings" && (
        <section className="rounded-2xl border border-parchment/10 bg-ink p-5">
          <p className="font-sans text-sm font-medium text-parchment">Emet brain · AI answers</p>
          <p className="mt-1 font-sans text-xs text-parchment-dim/70">
            Strong’s Hebrew/Greek dictionary is built in (offline). Connect an AI key so Emet can
            answer any question — definitions, history, people — in English, French and
            Kinyarwanda. Google Gemini has a free tier (aistudio.google.com); Anthropic Claude is
            paid (console.anthropic.com). If both are connected, Claude answers first and Gemini
            covers for it.
          </p>

          {/* Claude */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span
              className={`w-56 rounded px-2 py-1 font-sans text-xs ${
                brain?.claude ? "bg-mint/15 text-mint" : "bg-parchment/10 text-parchment-dim"
              }`}
            >
              {brain?.claude
                ? `● Claude connected (${brain.keyHint})`
                : "○ Claude not connected"}
              {brain?.model ? ` · ${brain.model}` : ""}
            </span>
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="sk-ant-…"
              className="min-w-[14rem] flex-1 rounded-md border border-parchment/15 bg-ink-soft px-3 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold/60"
            />
            <button
              onClick={() => void saveBrainKey(keyInput.trim(), "claude")}
              disabled={!keyInput.trim()}
              className="rounded-md bg-gold px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep disabled:opacity-30"
            >
              Save key
            </button>
            {brain?.claude && (
              <button
                onClick={() => void saveBrainKey("", "claude")}
                className="rounded-md border border-rose/40 px-3 py-1.5 font-sans text-xs text-rose transition hover:bg-rose/10"
              >
                Remove
              </button>
            )}
          </div>

          {brain?.claude && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="w-56 px-2 font-sans text-xs text-parchment-dim">
                Which Claude answers
              </span>
              <select
                value={brain.model}
                onChange={(e) => void saveBrainModel(e.target.value)}
                className="rounded-md border border-parchment/15 bg-ink-soft px-3 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold/60"
              >
                <option value="claude-opus-5">Opus 5 — the best answers (default)</option>
                <option value="claude-sonnet-5">Sonnet 5 — nearly as good, cheaper</option>
                <option value="claude-haiku-4-5">Haiku 4.5 — fastest and cheapest</option>
              </select>
              <span className="font-sans text-xs text-parchment-dim/60">
                Answers stream either way, so the first words reach the screen at
                about the same moment.
              </span>
            </div>
          )}

          {/* Gemini */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={`w-56 rounded px-2 py-1 font-sans text-xs ${
                brain?.gemini ? "bg-mint/15 text-mint" : "bg-parchment/10 text-parchment-dim"
              }`}
            >
              {brain?.gemini
                ? `● Gemini connected (${brain.geminiHint})`
                : "○ Gemini not connected (free)"}
              {brain?.geminiModel ? ` · ${brain.geminiModel}` : ""}
            </span>
            <input
              type="password"
              value={geminiInput}
              onChange={(e) => setGeminiInput(e.target.value)}
              placeholder="AIza…"
              className="min-w-[14rem] flex-1 rounded-md border border-parchment/15 bg-ink-soft px-3 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold/60"
            />
            <button
              onClick={() => void saveBrainKey(geminiInput.trim(), "gemini")}
              disabled={!geminiInput.trim()}
              className="rounded-md bg-gold px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep disabled:opacity-30"
            >
              Save key
            </button>
            {brain?.gemini && (
              <button
                onClick={() => void saveBrainKey("", "gemini")}
                className="rounded-md border border-rose/40 px-3 py-1.5 font-sans text-xs text-rose transition hover:bg-rose/10"
              >
                Remove
              </button>
            )}
          </div>

          {brainMsg && <p className="mt-2 font-sans text-xs text-sky">{brainMsg}</p>}
        </section>
        )}

        {tab === "churches" && (
        <>
        {/* Pending payment approvals */}
        {requests.length > 0 && (
          <section className="rounded-2xl border border-gold/30 bg-ink p-5">
            <p className="font-sans text-sm font-medium text-gold">
              Payments waiting for approval · {requests.length}
            </p>
            <ul className="mt-3 space-y-2">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-ink-soft p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-sans text-sm text-parchment">
                      {r.church || r.name} <span className="text-parchment-dim/60">· {r.email}</span>
                    </p>
                    <p className="font-sans text-xs text-parchment-dim">
                      {r.plan} · ref: <span className="text-sky">{r.payer_ref || "—"}</span> · {fmtDate(r.created_at)}
                    </p>
                  </div>
                  <button
                    onClick={() => resolve(r.id, true)}
                    className="rounded-md bg-mint/90 px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-mint"
                  >
                    ✓ Approve & activate
                  </button>
                  <button
                    onClick={() => resolve(r.id, false)}
                    className="rounded-md border border-rose/40 px-3 py-1.5 font-sans text-xs text-rose transition hover:bg-rose/10"
                  >
                    ✕ Reject
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Users */}
        <section className="rounded-2xl border border-parchment/10 bg-ink p-5">
          <div className="flex items-center justify-between gap-4">
            <p className="font-sans text-sm font-medium text-parchment">Churches</p>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search church, name or email…"
              className="w-64 rounded-lg border border-parchment/15 bg-ink-soft px-3 py-1.5 font-sans text-sm text-parchment placeholder:text-parchment-dim/40 outline-none focus:border-gold/60"
            />
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left font-sans text-sm">
              <thead>
                <tr className="border-b border-parchment/10 text-xs uppercase tracking-wider text-parchment-dim/60">
                  <th className="py-2 pr-4">Church / user</th>
                  <th className="py-2 pr-4">Joined</th>
                  <th className="py-2 pr-4">Subscription</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const activeNow = u.subscription && u.subscription.expiresAt * 1000 > Date.now()
                  return (
                    <tr key={u.id} className="border-b border-parchment/5">
                      <td className="py-2.5 pr-4">
                        <p className="text-parchment">{u.church || u.name}</p>
                        <p className="text-xs text-parchment-dim/60">{u.email}</p>
                      </td>
                      <td className="py-2.5 pr-4 text-parchment-dim">{fmtDate(u.createdAt)}</td>
                      <td className="py-2.5 pr-4">
                        {activeNow && u.subscription ? (
                          <span className="text-mint">
                            {u.subscription.plan} → {fmtDate(u.subscription.expiresAt)}
                          </span>
                        ) : (
                          <span className="text-rose">expired</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <div className="flex flex-wrap gap-1.5">
                          <button onClick={() => grant(u.id, "monthly")} className="rounded border border-parchment/15 px-2 py-1 text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold">
                            +1 month
                          </button>
                          <button onClick={() => grant(u.id, "yearly")} className="rounded border border-parchment/15 px-2 py-1 text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold">
                            +1 year
                          </button>
                          {activeNow && (
                            <button onClick={() => revoke(u.id)} className="rounded border border-rose/30 px-2 py-1 text-xs text-rose/80 transition hover:bg-rose/10">
                              revoke
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-parchment-dim/50">
                      No churches found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        </>
        )}
      </div>
    </main>
  )
}
