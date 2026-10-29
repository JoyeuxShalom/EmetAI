// Admin dashboard panels: engagement reports, assistants, security, email.
// Kept apart from Admin.tsx so each screen stays readable.

import { useCallback, useEffect, useState } from "react"
import {
  api,
  type AdminSession,
  type Assistant,
  type AuditEntry,
  type ChurchActivity,
  type PermissionInfo,
  type ReportsOverview,
} from "../lib/api"

function fmtDate(epoch: number) {
  if (!epoch) return "—"
  return new Date(epoch * 1000).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  })
}

function fmtWhen(epoch: number) {
  if (!epoch) return "never"
  const mins = Math.floor((Date.now() / 1000 - epoch) / 60)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`
  if (mins < 43200) return `${Math.floor(mins / 1440)} d ago`
  return fmtDate(epoch)
}

const card = "rounded-2xl border border-parchment/10 bg-ink p-5"
const label = "font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60"
const input =
  "rounded-lg border border-parchment/15 bg-ink-soft px-3 py-1.5 font-sans text-sm text-parchment placeholder:text-parchment-dim/40 outline-none focus:border-gold/60"

function Stat({ value, title, hint, tone = "gold" }: {
  value: string | number
  title: string
  hint?: string
  tone?: "gold" | "mint" | "sky" | "rose"
}) {
  const colour = { gold: "text-gold", mint: "text-mint", sky: "text-sky", rose: "text-rose" }[tone]
  return (
    <div className="rounded-xl border border-parchment/10 bg-ink p-4">
      <p className={`font-display text-3xl ${colour}`}>{value}</p>
      <p className="mt-1 font-sans text-xs uppercase tracking-[0.18em] text-parchment-dim/60">
        {title}
      </p>
      {hint && <p className="mt-1 font-sans text-xs text-parchment-dim/45">{hint}</p>}
    </div>
  )
}

/** Daily activity for the last 30 days, drawn as simple bars. */
function ActivityChart({ series }: { series: ReportsOverview["series"] }) {
  const peak = Math.max(1, ...series.map((d) => d.events))
  return (
    <div>
      <div className="flex h-28 items-end gap-[3px]">
        {series.map((d) => {
          const height = Math.max(2, Math.round((d.events / peak) * 100))
          return (
            <div
              key={d.day}
              title={`${d.day}: ${d.events} actions, ${d.users} church${d.users === 1 ? "" : "es"}`}
              className="flex-1 rounded-t bg-gold/70 transition hover:bg-gold"
              style={{ height: `${height}%` }}
            />
          )
        })}
      </div>
      <div className="mt-2 flex justify-between font-sans text-[0.65rem] text-parchment-dim/50">
        <span>{series[0]?.day.slice(5)}</span>
        <span>Daily activity · peak {peak}</span>
        <span>{series[series.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  )
}

export function ReportsPanel() {
  const [data, setData] = useState<ReportsOverview | null>(null)
  const [churches, setChurches] = useState<ChurchActivity[]>([])
  const [q, setQ] = useState("")
  const [sort, setSort] = useState("activity")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.reportsOverview().then(setData).catch((e) => setError(String(e.message ?? e)))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      api.reportsChurches(q, sort).then(setChurches).catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [q, sort])

  if (error) return <p className="font-sans text-sm text-rose">{error}</p>
  if (!data) return <p className="font-sans text-sm text-parchment-dim/60">Loading reports…</p>

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat value={data.activeToday} title="Active today" hint="churches that used EmetAI" />
        <Stat value={data.activeThisWeek} title="Active this week" tone="mint" />
        <Stat value={data.activeThisMonth} title="Active this month" tone="sky" />
        <Stat
          value={data.retentionRate === null ? "—" : `${data.retentionRate}%`}
          title="Still using it"
          hint={`of ${data.retentionCohort} churches that joined 1–4 weeks ago`}
          tone={data.retentionRate !== null && data.retentionRate < 40 ? "rose" : "mint"}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat value={data.churches} title="Churches" hint={`${data.verifiedChurches} email-verified`} />
        <Stat value={data.activeSubscriptions} title="Paying + trial" hint={`${data.trials} on trial`} />
        <Stat
          value={data.expiringThisWeek}
          title="Expiring in 7 days"
          tone={data.expiringThisWeek > 0 ? "rose" : "gold"}
          hint="worth a reminder call"
        />
        <Stat value={data.newChurchesThisMonth} title="New this month" tone="sky" />
      </div>

      <section className={card}>
        <p className={label}>Last 30 days</p>
        <div className="mt-4">
          <ActivityChart series={data.series} />
        </div>
      </section>

      <section className={card}>
        <p className={label}>What churches actually use</p>
        {data.features.length === 0 ? (
          <p className="mt-3 font-sans text-sm text-parchment-dim/50">
            No activity recorded yet — usage appears here after the first service.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {data.features.map((f) => {
              const top = data.features[0].count || 1
              return (
                <li key={f.event} className="flex items-center gap-3">
                  <span className="w-44 shrink-0 font-sans text-sm text-parchment">{f.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-soft">
                    <div
                      className="h-full rounded-full bg-gold/70"
                      style={{ width: `${Math.max(2, (f.count / top) * 100)}%` }}
                    />
                  </div>
                  <span className="w-28 shrink-0 text-right font-sans text-xs text-parchment-dim">
                    {f.count.toLocaleString()} · {f.churches} church{f.churches === 1 ? "" : "es"}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={label}>Church by church · last 30 days</p>
          <div className="flex gap-2">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className={input}
            >
              <option value="activity">Most active</option>
              <option value="recent">Recently seen</option>
              <option value="new">Newest</option>
            </select>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search church…"
              className={`${input} w-56`}
            />
          </div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left font-sans text-sm">
            <thead>
              <tr className="border-b border-parchment/10 text-xs uppercase tracking-wider text-parchment-dim/60">
                <th className="py-2 pr-4">Church</th>
                <th className="py-2 pr-4">Last seen</th>
                <th className="py-2 pr-4">Active days</th>
                <th className="py-2 pr-4">Verses</th>
                <th className="py-2 pr-4">Voice</th>
                <th className="py-2 pr-4">AI</th>
                <th className="py-2">Listening</th>
              </tr>
            </thead>
            <tbody>
              {churches.map((c) => (
                <tr key={c.id} className="border-b border-parchment/5">
                  <td className="py-2.5 pr-4">
                    <p className="text-parchment">{c.church || c.name}</p>
                    <p className="text-xs text-parchment-dim/60">
                      {c.email}
                      {!c.emailVerified && <span className="ml-1.5 text-rose">· unverified</span>}
                      {c.status !== "active" && <span className="ml-1.5 text-rose">· suspended</span>}
                    </p>
                  </td>
                  <td className="py-2.5 pr-4 text-parchment-dim">{fmtWhen(c.lastSeenAt)}</td>
                  <td className="py-2.5 pr-4 text-parchment-dim">{c.activeDays}/30</td>
                  <td className="py-2.5 pr-4 text-parchment">{c.versesShown}</td>
                  <td className="py-2.5 pr-4 text-parchment">{c.voiceCommands}</td>
                  <td className="py-2.5 pr-4 text-parchment">{c.aiQuestions}</td>
                  <td className="py-2.5 text-parchment">{c.listeningSessions}</td>
                </tr>
              ))}
              {churches.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-parchment-dim/50">
                    No churches match that search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

export function AssistantsPanel() {
  const [rows, setRows] = useState<Assistant[]>([])
  const [perms, setPerms] = useState<PermissionInfo[]>([])
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [chosen, setChosen] = useState<string[]>(["users.view", "reports.view"])
  const [msg, setMsg] = useState<string | null>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setRows(await api.assistants())
      setPerms(await api.permissionList())
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load assistants.")
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const grantable = perms.filter((p) => !p.adminOnly)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMsg(null)
    setTempPassword(null)
    try {
      const res = await api.createAssistant({ email, name, permissions: chosen })
      setEmail("")
      setName("")
      setMsg(
        res.emailSent
          ? "Assistant created — the invitation with their temporary password is on its way."
          : res.notice ?? "Assistant created."
      )
      if (res.temporaryPassword) setTempPassword(res.temporaryPassword)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the assistant.")
    }
  }

  async function toggle(a: Assistant, permission: string) {
    const next = a.permissions.includes(permission)
      ? a.permissions.filter((p) => p !== permission)
      : [...a.permissions, permission]
    await api.updateAssistant(a.id, { permissions: next })
    await reload()
  }

  async function setStatus(a: Assistant, status: "active" | "suspended") {
    await api.updateAssistant(a.id, { status })
    await reload()
  }

  async function remove(a: Assistant) {
    if (!window.confirm(`Remove ${a.email}? They lose access immediately.`)) return
    await api.deleteAssistant(a.id)
    await reload()
  }

  return (
    <div className="space-y-5">
      <section className={card}>
        <p className={label}>Add an assistant</p>
        <p className="mt-2 font-sans text-xs text-parchment-dim/70">
          An assistant helps you run EmetAI but only within the powers you tick. They can never
          change AI or email keys, and they can never create other assistants — those stay with
          you alone.
        </p>
        <form onSubmit={create} className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="assistant@church.rw"
              className={`${input} min-w-[16rem] flex-1`}
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Their name (optional)"
              className={`${input} min-w-[12rem] flex-1`}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {grantable.map((p) => {
              const on = chosen.includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    setChosen(on ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])
                  }
                  className={`rounded-lg border px-3 py-1.5 text-left font-sans text-xs transition ${
                    on ? "border-gold/60 bg-gold/10 text-gold" : "border-parchment/15 text-parchment-dim"
                  }`}
                >
                  {on ? "✓ " : ""}
                  {p.label}
                </button>
              )
            })}
          </div>
          <button
            type="submit"
            className="rounded-lg bg-gold px-4 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep"
          >
            Create assistant
          </button>
        </form>
        {msg && <p className="mt-3 font-sans text-sm text-mint">{msg}</p>}
        {tempPassword && (
          <div className="mt-3 rounded-lg border border-gold/40 bg-gold/5 p-3">
            <p className="font-sans text-xs text-gold">
              Email is not connected, so pass this temporary password on yourself — it is shown
              only once:
            </p>
            <code className="mt-1.5 block font-mono text-sm tracking-wider text-gold">
              {tempPassword}
            </code>
          </div>
        )}
        {error && <p className="mt-3 font-sans text-sm text-rose">{error}</p>}
      </section>

      <section className={card}>
        <p className={label}>Assistants · {rows.length}</p>
        {rows.length === 0 ? (
          <p className="mt-3 font-sans text-sm text-parchment-dim/50">
            No assistants yet. You are the only person with access.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {rows.map((a) => (
              <li key={a.id} className="rounded-xl bg-ink-soft p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-sans text-sm text-parchment">
                      {a.name || a.email}
                      {a.status !== "active" && (
                        <span className="ml-2 rounded bg-rose/15 px-1.5 py-0.5 text-xs text-rose">
                          suspended
                        </span>
                      )}
                    </p>
                    <p className="font-sans text-xs text-parchment-dim/60">
                      {a.email} · joined {fmtDate(a.createdAt)} · last seen {fmtWhen(a.lastSeenAt)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void setStatus(a, a.status === "active" ? "suspended" : "active")}
                      className="rounded-md border border-parchment/20 px-3 py-1.5 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                    >
                      {a.status === "active" ? "Suspend" : "Restore"}
                    </button>
                    <button
                      onClick={() => void remove(a)}
                      className="rounded-md border border-rose/40 px-3 py-1.5 font-sans text-xs text-rose transition hover:bg-rose/10"
                    >
                      Remove
                    </button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {grantable.map((p) => {
                    const on = a.permissions.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        onClick={() => void toggle(a, p.id)}
                        className={`rounded border px-2 py-1 font-sans text-[0.68rem] transition ${
                          on
                            ? "border-mint/40 bg-mint/10 text-mint"
                            : "border-parchment/15 text-parchment-dim/60 hover:border-parchment/30"
                        }`}
                      >
                        {on ? "✓ " : "+ "}
                        {p.label}
                      </button>
                    )
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export function SecurityPanel({ isAdmin }: { isAdmin: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [sessions, setSessions] = useState<AdminSession[]>([])
  const [q, setQ] = useState("")

  const reload = useCallback(async () => {
    try {
      setEntries(await api.auditLog(q, 150))
    } catch {
      /* the assistant may not hold audit.view */
    }
    if (isAdmin) {
      try {
        setSessions(await api.adminSessions())
      } catch {
        /* ignore */
      }
    }
  }, [q, isAdmin])

  useEffect(() => {
    const t = setTimeout(() => void reload(), 250)
    return () => clearTimeout(t)
  }, [reload])

  async function endSession(id: string) {
    await api.adminRevokeSession({ sessionId: id })
    await reload()
  }

  return (
    <div className="space-y-5">
      {isAdmin && (
        <section className={card}>
          <p className={label}>Signed in right now · {sessions.length}</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left font-sans text-sm">
              <thead>
                <tr className="border-b border-parchment/10 text-xs uppercase tracking-wider text-parchment-dim/60">
                  <th className="py-2 pr-4">Who</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4">Address</th>
                  <th className="py-2 pr-4">Last active</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-b border-parchment/5">
                    <td className="py-2.5 pr-4">
                      <p className="text-parchment">{s.church || s.name}</p>
                      <p className="text-xs text-parchment-dim/60">{s.email}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-parchment-dim">{s.role}</td>
                    <td className="py-2.5 pr-4 text-parchment-dim">{s.ip || "—"}</td>
                    <td className="py-2.5 pr-4 text-parchment-dim">{fmtWhen(s.lastSeenAt)}</td>
                    <td className="py-2.5">
                      <button
                        onClick={() => void endSession(s.id)}
                        className="rounded-md border border-rose/40 px-2.5 py-1 font-sans text-xs text-rose transition hover:bg-rose/10"
                      >
                        Sign out
                      </button>
                    </td>
                  </tr>
                ))}
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-parchment-dim/50">
                      Nobody is signed in.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={label}>Audit log</p>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by action, person or target…"
            className={`${input} w-72`}
          />
        </div>
        <ul className="mt-4 space-y-1.5">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-ink-soft px-3 py-2 font-sans text-xs"
            >
              <span className="w-36 shrink-0 text-parchment-dim/50">{fmtWhen(e.createdAt)}</span>
              <span className="font-medium text-gold">{e.action}</span>
              <span className="text-parchment">{e.actor}</span>
              {e.target && <span className="text-parchment-dim">→ {e.target}</span>}
              {e.detail && <span className="text-parchment-dim/60">({e.detail})</span>}
              {e.ip && <span className="ml-auto text-parchment-dim/40">{e.ip}</span>}
            </li>
          ))}
          {entries.length === 0 && (
            <li className="py-6 text-center font-sans text-sm text-parchment-dim/50">
              Nothing recorded yet.
            </li>
          )}
        </ul>
      </section>
    </div>
  )
}

type EmailStatus = Awaited<ReturnType<typeof api.emailStatus>>

export function EmailPanel() {
  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [chosen, setChosen] = useState("resend")
  const [key, setKey] = useState("")
  const [from, setFrom] = useState("")
  const [testTo, setTestTo] = useState("")
  const [msg, setMsg] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    try {
      const s = await api.emailStatus()
      setStatus(s)
      setFrom(s.from)
      setChosen(s.provider)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const spec = status?.providers.find((p) => p.id === chosen)

  async function save() {
    setMsg(null)
    setWarning(null)
    setError(null)
    setSaving(true)
    try {
      const res = await api.setEmailKey(key.trim(), from.trim(), chosen)
      setKey("")
      await reload()
      setWarning(res.warning)
      setMsg(res.message)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the key.")
    } finally {
      setSaving(false)
    }
  }

  async function test() {
    setMsg(null)
    setWarning(null)
    setError(null)
    try {
      await api.sendTestEmail(testTo.trim())
      setMsg(`Test message sent to ${testTo.trim()} — check the inbox (and spam).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the test.")
    }
  }

  return (
    <section className={card}>
      <p className={label}>Email delivery</p>
      <p className="mt-2 font-sans text-xs text-parchment-dim/70">
        EmetAI emails sign-in codes, email confirmations and password resets. Until a key is
        connected, codes are printed in the server window and sign-in falls back to the password
        alone. Pick whichever service suits you — you can switch at any time.
      </p>

      {/* Which service sends the mail */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {(status?.providers ?? []).map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setChosen(p.id)
              setKey("")
              setMsg(null)
              setWarning(null)
              setError(null)
            }}
            className={`rounded-xl border p-3 text-left transition ${
              chosen === p.id
                ? "border-gold/60 bg-gold/10"
                : "border-parchment/15 hover:border-parchment/30"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-sans text-sm text-parchment">{p.label}</span>
              <span
                className={`font-sans text-[0.65rem] ${
                  p.configured ? "text-mint" : "text-parchment-dim/50"
                }`}
              >
                {p.configured ? "● key saved" : "○ no key"}
                {status?.provider === p.id ? " · in use" : ""}
              </span>
            </div>
            <p className="mt-1 font-sans text-[0.7rem] leading-relaxed text-parchment-dim/70">
              {p.note}
            </p>
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-2 py-1 font-sans text-xs ${
            spec?.configured ? "bg-mint/15 text-mint" : "bg-rose/15 text-rose"
          }`}
        >
          {spec?.configured
            ? `● ${spec.label} key saved${status?.provider === chosen ? ` (${status.keyHint})` : ""}`
            : `○ No ${spec?.label ?? ""} key`}
        </span>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={spec?.keyHint ?? "key"}
          className={`${input} min-w-[14rem] flex-1`}
        />
        <button
          onClick={() => void save()}
          disabled={!key.trim() || saving}
          className="rounded-md bg-gold px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep disabled:opacity-30"
        >
          {saving ? "Sending test…" : "Save key"}
        </button>
        {spec?.configured && (
          <button
            onClick={() => {
              setKey("")
              void api.setEmailKey("", from, chosen).then(reload)
            }}
            className="rounded-md border border-rose/40 px-3 py-1.5 font-sans text-xs text-rose transition hover:bg-rose/10"
          >
            Remove
          </button>
        )}
      </div>
      {spec && (
        <p className="mt-1.5 font-sans text-[0.7rem] text-parchment-dim/50">
          Get the key from <b className="text-parchment-dim/70">{spec.where}</b>. Saving it sends a
          real test message, so you will know immediately whether it works.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="w-44 font-sans text-xs text-parchment-dim/60">Sender address</span>
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          placeholder="EmetAI &lt;noreply@yourchurch.rw&gt;"
          className={`${input} min-w-[16rem] flex-1`}
        />
      </div>
      <p className="mt-1 font-sans text-[0.7rem] leading-relaxed text-parchment-dim/50">
        {chosen === "brevo" ? (
          <>
            Brevo will only send from an address you have validated. Add it in Brevo under{" "}
            <b className="text-parchment-dim/70">Senders, Domains &amp; Dedicated IPs → Senders</b>,
            click the link Brevo emails you, then put that same address here — for example{" "}
            <b className="text-parchment-dim/70">EmetAI &lt;yourname@gmail.com&gt;</b>. No domain
            required.
          </>
        ) : (
          <>
            <b className="text-parchment-dim/70">onboarding@resend.dev</b> is Resend's shared
            testing sender: it delivers only to the address that owns your Resend account. To
            email churches, verify your own domain in Resend and set the sender to it.
          </>
        )}
      </p>

      {status?.configured && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="w-44 font-sans text-xs text-parchment-dim/60">Send a test</span>
          <input
            type="email"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="your@email.com"
            className={`${input} min-w-[14rem] flex-1`}
          />
          <button
            onClick={() => void test()}
            disabled={!testTo.trim()}
            className="rounded-md border border-parchment/20 px-3 py-1.5 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold disabled:opacity-30"
          >
            Send test
          </button>
        </div>
      )}

      {msg && <p className="mt-3 font-sans text-sm text-mint">{msg}</p>}
      {warning && (
        <p className="mt-3 rounded-lg border border-gold/30 bg-gold/5 px-3 py-2 font-sans text-sm text-gold/90">
          {warning}
        </p>
      )}
      {error && <p className="mt-3 font-sans text-sm text-rose">{error}</p>}
    </section>
  )
}
