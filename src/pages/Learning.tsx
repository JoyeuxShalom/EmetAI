// Where a service is reviewed after it has happened, and where EmetAI's
// mistakes turn into things it knows.
//
// The Studio lets an operator correct a line while the service is running, but
// nobody running a projector mid-sermon is going to correct much. The real
// work happens here, afterwards: read back everything that was heard, see what
// EmetAI did with each line, and fix the ones it got wrong. Every fix is in
// the ear's vocabulary before the next service.

import { useEffect, useState } from "react"

import { api, type LexiconTerm, type ServiceLine, type ServiceRecord } from "../lib/api"

function when(seconds: number): string {
  if (!seconds) return "—"
  return new Date(seconds * 1000).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function minutes(row: ServiceRecord): string {
  if (!row.ended_at) return "still open"
  const mins = Math.max(1, Math.round((row.ended_at - row.started_at) / 60))
  return `${mins} min`
}

const ACTION_STYLE: Record<string, string> = {
  detected: "border-gold/40 text-gold",
  projected: "border-mint/40 text-mint",
  command: "border-sky-400/40 text-sky-300",
  answer: "border-violet-400/40 text-violet-300",
  ignored: "border-parchment/15 text-parchment-dim/50",
}

export default function Learning() {
  const [services, setServices] = useState<ServiceRecord[]>([])
  const [openId, setOpenId] = useState<string>("")
  const [lines, setLines] = useState<ServiceLine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [fixing, setFixing] = useState<{ id: string; heard: string; text: string } | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const [terms, setTerms] = useState<LexiconTerm[]>([])
  const [shipped, setShipped] = useState(0)
  const [newTerm, setNewTerm] = useState("")
  const [onlyMissed, setOnlyMissed] = useState(false)

  async function loadServices() {
    try {
      const res = await api.services()
      setServices(res.services)
      if (!openId && res.services.length) setOpenId(res.services[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your services.")
    } finally {
      setLoading(false)
    }
  }

  async function loadLexicon() {
    try {
      const res = await api.lexicon()
      setTerms(res.terms)
      setShipped(res.shipped)
    } catch {
      /* the page is still useful without it */
    }
  }

  useEffect(() => {
    void loadServices()
    void loadLexicon()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!openId) return
    let alive = true
    void api
      .service(openId)
      .then((res) => alive && setLines(res.lines))
      .catch(() => alive && setLines([]))
    return () => {
      alive = false
    }
  }, [openId])

  function say(message: string) {
    setFlash(message)
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function teach(heard: string, correct: string) {
    const fixed = correct.trim()
    if (!fixed || fixed === heard.trim()) {
      setFixing(null)
      return
    }
    try {
      const res = await api.teachCorrection({ heard, correct: fixed, service_id: openId })
      const words = res.learned.filter((w) => w !== "alias")
      say(words.length ? `Learned: ${words.join(", ")}` : "Noted — Emet already knew that one")
      void loadLexicon()
    } catch (e) {
      say(e instanceof Error ? e.message : "Could not save that correction.")
    }
    setFixing(null)
  }

  async function addTerm() {
    const word = newTerm.trim()
    if (!word) return
    setNewTerm("")
    try {
      const res = await api.addTerm({ correct: word })
      say(res.added ? `Emet is now listening for "${word}"` : `Already knew "${word}"`)
      void loadLexicon()
    } catch {
      say("Could not add that word.")
    }
  }

  const shown = onlyMissed ? lines.filter((l) => l.action === "ignored") : lines
  const open = services.find((s) => s.id === openId)

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header>
        <h1 className="font-serif text-3xl text-parchment">What Emet has learned</h1>
        <p className="mt-2 max-w-3xl font-sans text-sm leading-relaxed text-parchment-dim">
          Every service is recorded here — what Emet heard, and what it did with each line.
          Correct a line and Emet learns two things at once: the exact mishearing is repaired
          in future transcripts, and the words are handed to the ear <em>before</em> it listens
          next time, so it is more likely to get them right in the first place.
        </p>
      </header>

      {flash && (
        <p className="mt-4 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 font-sans text-sm text-gold">
          {flash}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-rose/40 bg-rose/10 px-3 py-2 font-sans text-sm text-rose-200">
          {error}
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Services */}
        <section className="lg:col-span-4">
          <h2 className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
            Services
          </h2>
          <div className="mt-3 space-y-2">
            {loading && <p className="font-sans text-sm text-parchment-dim/50">Loading…</p>}
            {!loading && services.length === 0 && (
              <p className="rounded-lg border border-parchment/10 bg-ink p-4 font-sans text-sm leading-relaxed text-parchment-dim">
                Nothing recorded yet. Press <strong className="text-parchment">Listen</strong> in
                the Studio and a service will appear here — with every line Emet heard, ready to
                be reviewed once the service is over.
              </p>
            )}
            {services.map((s) => (
              <button
                key={s.id}
                onClick={() => setOpenId(s.id)}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  s.id === openId
                    ? "border-gold/50 bg-gold/5"
                    : "border-parchment/10 bg-ink hover:border-parchment/25"
                }`}
              >
                <p className="font-sans text-sm text-parchment">{s.title || when(s.started_at)}</p>
                <p className="mt-0.5 font-sans text-xs text-parchment-dim/60">
                  {when(s.started_at)} · {minutes(s)} · {s.lines} lines
                  {s.corrections > 0 && ` · ${s.corrections} taught`}
                </p>
                <p className="mt-1 font-sans text-[11px] text-parchment-dim/40">{s.ear}</p>
              </button>
            ))}
          </div>

          {/* Vocabulary */}
          <h2 className="mt-8 font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
            Emet's vocabulary
          </h2>
          <p className="mt-2 font-sans text-xs leading-relaxed text-parchment-dim/70">
            {shipped} words ship with EmetAI — every Bible book name in Kinyarwanda, English and
            French, plus church vocabulary. Below are the ones your church has taught it. Add the
            names Emet keeps getting wrong: your apostle, your elders, your town.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={newTerm}
              onChange={(e) => setNewTerm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addTerm()}
              placeholder="A name Emet should know…"
              className="min-w-0 flex-1 rounded-md border border-parchment/20 bg-ink px-2.5 py-1.5 font-sans text-sm text-parchment outline-none placeholder:text-parchment-dim/40 focus:border-gold"
            />
            <button
              onClick={() => void addTerm()}
              className="shrink-0 rounded-md bg-gold px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep"
            >
              Teach
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {terms.length === 0 && (
              <p className="font-sans text-xs text-parchment-dim/40">
                Nothing taught yet — correct a line on the right and it appears here.
              </p>
            )}
            {terms.map((t) => (
              <span
                key={t.id}
                title={
                  t.kind === "alias"
                    ? `Heard as "${t.heard}" — repaired to "${t.correct}"`
                    : `Taught ${t.weight > 1 ? `${t.weight} times` : "once"} (${t.source})`
                }
                className={`group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-xs ${
                  t.kind === "alias"
                    ? "border-sky-400/30 text-sky-200/80"
                    : "border-parchment/20 text-parchment-dim"
                }`}
              >
                {t.kind === "alias" ? `${t.heard} → ${t.correct}` : t.correct}
                <button
                  onClick={async () => {
                    await api.deleteTerm(t.id).catch(() => {})
                    void loadLexicon()
                  }}
                  title="Forget this"
                  className="text-parchment-dim/0 transition group-hover:text-rose-300"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </section>

        {/* The transcript of one service */}
        <section className="lg:col-span-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
              {open ? open.title || when(open.started_at) : "Transcript"}
            </h2>
            {lines.length > 0 && (
              <label className="flex items-center gap-2 font-sans text-xs text-parchment-dim">
                <input
                  type="checkbox"
                  checked={onlyMissed}
                  onChange={(e) => setOnlyMissed(e.target.checked)}
                  className="accent-gold"
                />
                Only lines Emet did nothing with
              </label>
            )}
          </div>

          <div className="mt-3 space-y-1.5">
            {openId && lines.length === 0 && (
              <p className="rounded-lg border border-parchment/10 bg-ink p-4 font-sans text-sm text-parchment-dim">
                No lines recorded for this service.
              </p>
            )}
            {shown.map((line) =>
              fixing?.id === line.id ? (
                <form
                  key={line.id}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void teach(fixing.heard, fixing.text)
                  }}
                  className="rounded-lg border border-gold/40 bg-gold/5 p-3"
                >
                  <label className="font-sans text-[11px] uppercase tracking-wider text-gold/80">
                    What was actually said?
                  </label>
                  <input
                    autoFocus
                    value={fixing.text}
                    onChange={(e) => setFixing({ ...fixing, text: e.target.value })}
                    onKeyDown={(e) => e.key === "Escape" && setFixing(null)}
                    className="mt-1 w-full rounded-md border border-parchment/20 bg-ink px-2 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="submit"
                      className="rounded-md bg-gold px-3 py-1 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep"
                    >
                      Teach Emet
                    </button>
                    <button
                      type="button"
                      onClick={() => setFixing(null)}
                      className="rounded-md border border-parchment/20 px-3 py-1 font-sans text-xs text-parchment-dim transition hover:border-parchment/40"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div
                  key={line.id}
                  className="group flex items-start gap-3 rounded-lg border border-parchment/10 bg-ink px-3 py-2"
                >
                  <span
                    className={`mt-0.5 shrink-0 rounded-full border px-1.5 py-px font-sans text-[10px] uppercase tracking-wider ${
                      ACTION_STYLE[line.action] ?? ACTION_STYLE.ignored
                    }`}
                  >
                    {line.action}
                  </span>
                  <span className="flex-1 font-sans text-sm text-parchment-dim">
                    {line.heard}
                    {line.result && (
                      <span className="ml-2 font-sans text-xs text-parchment/60">
                        → {line.result}
                        {line.score ? ` (${Math.round(line.score * 100)}%)` : ""}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => setFixing({ id: line.id, heard: line.heard, text: line.heard })}
                    className="mt-0.5 shrink-0 rounded px-1 font-sans text-[11px] text-parchment-dim/0 transition group-hover:text-gold/70 hover:!text-gold"
                  >
                    ✎ fix
                  </button>
                </div>
              )
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
