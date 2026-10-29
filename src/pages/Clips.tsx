// Clips studio: paste a YouTube sermon, get caption-burned, social-ready cuts.

import { useEffect, useRef, useState } from "react"
import { api, clipFileUrl, type CaptionLine, type ClipInfo, type ClipJob } from "../lib/api"
import { useAuth } from "../lib/auth"

const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting in line…",
  downloading: "Downloading the sermon…",
  transcribing: "Listening to every word…",
  scoring: "Finding the most powerful moments…",
  cutting: "Cutting and captioning…",
  done: "Ready",
  error: "Failed",
}

function fmtTime(s: number) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`
}

export default function Clips() {
  const { user } = useAuth()
  const [url, setUrl] = useState("")
  const [clipSeconds, setClipSeconds] = useState(120)
  const [count, setCount] = useState(3)
  const [format, setFormat] = useState("vertical")
  const [language, setLanguage] = useState("auto")
  const [mode, setMode] = useState("clips")
  const [jobs, setJobs] = useState<ClipJob[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<number | null>(null)

  // Editing state: which clip is open, its draft, and the job's transcript.
  const [editing, setEditing] = useState<{ jobId: string; index: number } | null>(null)
  const [draft, setDraft] = useState<{ start: number; end: number; captions: CaptionLine[] } | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const transcriptsRef = useRef<Record<string, CaptionLine[]>>({})

  // Bumped whenever a job finishes, so <video> tags reload the fresh file.
  const [videoVer, setVideoVer] = useState(0)
  const prevStatusRef = useRef<Record<string, string>>({})

  async function reload() {
    try {
      const next = await api.clipJobs()
      const prev = prevStatusRef.current
      if (next.some((j) => j.status === "done" && prev[j.id] && prev[j.id] !== "done")) {
        setVideoVer((v) => v + 1)
      }
      prevStatusRef.current = Object.fromEntries(next.map((j) => [j.id, j.status]))
      setJobs(next)
    } catch {
      /* not signed in yet */
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  // Poll while any job is running.
  useEffect(() => {
    const running = jobs.some((j) => j.status !== "done" && j.status !== "error")
    if (running && pollRef.current === null) {
      pollRef.current = window.setInterval(reload, 2500)
    }
    if (!running && pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [jobs])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.createClipJob({ url, clipSeconds, count, format, language, mode })
      setUrl("")
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the job.")
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    await api.deleteClipJob(id).catch(() => {})
    await reload()
  }

  // ---- Clip editing ----

  function linesInWindow(jobId: string, start: number, end: number, keepEdits: CaptionLine[]): CaptionLine[] {
    const transcript = transcriptsRef.current[jobId] ?? []
    const edited = new Map(keepEdits.map((c) => [c.start, c.text]))
    return transcript
      .filter((l) => l.end > start && l.start < end)
      .map((l) => ({ ...l, text: edited.get(l.start) ?? l.text }))
  }

  async function openEdit(job: ClipJob, clip: ClipInfo) {
    setEditError(null)
    try {
      if (!transcriptsRef.current[job.id]) {
        transcriptsRef.current[job.id] = await api.clipTranscript(job.id)
      }
      setEditing({ jobId: job.id, index: clip.index })
      setDraft({
        start: clip.start,
        end: clip.end,
        captions: linesInWindow(job.id, clip.start, clip.end, []),
      })
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not load the transcript.")
    }
  }

  function moveWindow(start: number, end: number) {
    if (!editing || !draft) return
    setDraft({ start, end, captions: linesInWindow(editing.jobId, start, end, draft.captions) })
  }

  async function submitEdit() {
    if (!editing || !draft) return
    setEditError(null)
    if (draft.end - draft.start < 5) {
      setEditError("A clip must be at least 5 seconds long.")
      return
    }
    setEditBusy(true)
    try {
      await api.editClip(editing.jobId, editing.index, draft)
      setEditing(null)
      setDraft(null)
      await reload() // job goes to 'cutting'; polling picks up the rest
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Re-render failed to start.")
    } finally {
      setEditBusy(false)
    }
  }

  const selectCls =
    "rounded-lg border border-parchment/15 bg-ink px-3 py-2 font-sans text-sm text-parchment outline-none focus:border-gold/60"

  return (
    <main className="h-full overflow-y-auto bg-ink-soft px-4 py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="font-display text-2xl font-[440] text-parchment">Sermon clips studio</h1>
          <p className="mt-1 font-sans text-sm text-parchment-dim">
            Paste a YouTube sermon — EmetAI finds the most powerful teaching moments and cuts
            them into caption-burned clips ready for TikTok, Reels and Shorts.
          </p>
        </div>

        {/* What this plan allows */}
        {user && user.role === "church" && (
          <div
            className={`rounded-xl border p-4 ${
              user.quota.clips.limit === 0
                ? "border-gold/30 bg-gold/5"
                : "border-parchment/10 bg-ink"
            }`}
          >
            {user.quota.clips.limit === 0 ? (
              <>
                <p className="font-sans text-sm font-medium text-gold">
                  Sermon clips are part of the Pro plan
                </p>
                <p className="mt-1 font-sans text-xs leading-relaxed text-parchment-dim">
                  Pro includes 10 clips a month; Max is unlimited. Your scripture display stays
                  free for ever either way.
                </p>
                <a
                  href="#/account"
                  className="mt-2.5 inline-block rounded-md bg-gold px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep"
                >
                  See the plans →
                </a>
              </>
            ) : (
              <p className="font-sans text-sm text-parchment-dim">
                <span className="text-parchment">{user.tierLabel} plan</span> ·{" "}
                {user.quota.clips.limit === null
                  ? "unlimited clips this month"
                  : `${user.quota.clips.used} of ${user.quota.clips.limit} clips used this month`}
              </p>
            )}
          </div>
        )}

        {/* New job */}
        <form onSubmit={submit} className="rounded-2xl border border-parchment/10 bg-ink p-5">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            required
            className="w-full rounded-lg border border-parchment/15 bg-ink-soft px-4 py-2.5 font-sans text-base text-parchment placeholder:text-parchment-dim/40 outline-none transition focus:border-gold/60"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 font-sans text-sm text-parchment-dim">
              Output
              <select value={mode} onChange={(e) => setMode(e.target.value)} className={selectCls}>
                <option value="clips">Viral cuts</option>
                <option value="full">Full video + captions</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label className={`flex items-center gap-2 font-sans text-sm text-parchment-dim ${mode === "full" ? "opacity-40" : ""}`}>
              Length
              <select value={clipSeconds} disabled={mode === "full"} onChange={(e) => setClipSeconds(Number(e.target.value))} className={selectCls}>
                <option value={90}>1:30</option>
                <option value={120}>2:00</option>
                <option value={150}>2:30</option>
                <option value={180}>3:00</option>
              </select>
            </label>
            <label className={`flex items-center gap-2 font-sans text-sm text-parchment-dim ${mode === "full" ? "opacity-40" : ""}`}>
              Clips
              <select value={count} disabled={mode === "full"} onChange={(e) => setCount(Number(e.target.value))} className={selectCls}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 font-sans text-sm text-parchment-dim">
              Format
              <select value={format} onChange={(e) => setFormat(e.target.value)} className={selectCls}>
                <option value="vertical">Vertical 9:16 (Reels/TikTok)</option>
                <option value="original">Original (YouTube)</option>
              </select>
            </label>
            <label
              className="flex items-center gap-2 font-sans text-sm text-parchment-dim"
              title="When the sermon has an interpreter, pick a language — captions follow only that voice."
            >
              Captions
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className={selectCls}>
                <option value="auto">All speech (auto)</option>
                <option value="rw">Kinyarwanda only</option>
                <option value="en">English only</option>
                <option value="fr">French only</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={busy}
              className="ml-auto rounded-lg bg-gold px-5 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep disabled:opacity-50"
            >
              {busy ? "Starting…" : "Create clips →"}
            </button>
          </div>
          {error && <p className="mt-3 font-sans text-sm text-rose">{error}</p>}
          <p className="mt-3 font-sans text-xs text-parchment-dim/50">
            Interpreted sermon? Choose the caption language — EmetAI captions only that
            voice. Vertical clips auto-center on the preacher's face.
          </p>
        </form>

        {/* Jobs */}
        {jobs.length === 0 && (
          <p className="py-8 text-center font-sans text-sm text-parchment-dim/50">
            Your clip jobs will appear here. Long sermons take a while — you can leave this
            page and come back.
          </p>
        )}
        {jobs.map((job) => (
          <section key={job.id} className="rounded-2xl border border-parchment/10 bg-ink p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate font-sans text-sm text-sky">{job.url}</p>
                <p className="mt-1 font-sans text-xs text-parchment-dim/60">
                  {job.params.count} × ~{fmtTime(job.params.clip_seconds)} ·{" "}
                  {job.params.format === "vertical" ? "9:16" : "original"} · {job.params.language}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {job.status !== "done" && job.status !== "error" ? (
                  <span className="animate-pulse-soft rounded-full border border-gold/40 px-3 py-1 font-sans text-xs text-gold">
                    {job.progress || STATUS_LABEL[job.status] || job.status}
                  </span>
                ) : (
                  <>
                    <span
                      className={`rounded-full border px-3 py-1 font-sans text-xs ${
                        job.status === "done" ? "border-mint/40 text-mint" : "border-rose/40 text-rose"
                      }`}
                    >
                      {STATUS_LABEL[job.status]}
                    </span>
                    <button
                      onClick={() => remove(job.id)}
                      title="Delete job and its clips"
                      className="rounded-md border border-parchment/15 px-2 py-1 font-sans text-xs text-parchment-dim transition hover:border-rose/50 hover:text-rose"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            </div>

            {job.error && (
              <p className="mt-3 rounded-lg bg-rose/10 p-3 font-sans text-sm text-rose">{job.error}</p>
            )}

            {job.clips.length > 0 && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {job.clips.map((c) => (
                  <div key={c.index} className="overflow-hidden rounded-xl border border-parchment/10 bg-ink-soft">
                    <video
                      src={`${clipFileUrl(job.id, c.file)}&v=${videoVer}`}
                      controls
                      preload="metadata"
                      className="aspect-video w-full bg-black object-contain"
                    />
                    <div className="p-3">
                      <p className="line-clamp-2 font-sans text-sm text-parchment">
                        {c.index === 0 ? c.title : `“${c.title}”`}
                      </p>
                      <p className="mt-1 font-sans text-xs text-parchment-dim/60">
                        {fmtTime(c.start)} → {fmtTime(c.end)} · {fmtTime(c.duration)} long
                      </p>
                      <div className="mt-2 flex gap-1.5">
                        <a
                          href={clipFileUrl(job.id, c.file)}
                          download={`emetai_${c.file}`}
                          className="rounded-md bg-gold px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep"
                        >
                          ↓ Download
                        </a>
                        {c.index > 0 && job.status === "done" && (
                          <button
                            onClick={() => openEdit(job, c)}
                            className="rounded-md border border-parchment/20 px-3 py-1.5 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                          >
                            ✎ Edit
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Edit panel: adjust the cut, rewrite captions, re-render */}
            {editing?.jobId === job.id && draft && (
              <div className="mt-4 rounded-xl border border-gold/40 bg-ink-soft p-4">
                <p className="font-sans text-sm font-medium text-gold">
                  Editing clip {editing.index}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 font-sans text-sm text-parchment-dim">
                    Start (sec)
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      value={draft.start}
                      onChange={(e) => moveWindow(Number(e.target.value), draft.end)}
                      className="w-24 rounded-lg border border-parchment/15 bg-ink px-3 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold/60"
                    />
                    <span className="text-xs text-parchment-dim/50">{fmtTime(draft.start)}</span>
                  </label>
                  <label className="flex items-center gap-2 font-sans text-sm text-parchment-dim">
                    End (sec)
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      value={draft.end}
                      onChange={(e) => moveWindow(draft.start, Number(e.target.value))}
                      className="w-24 rounded-lg border border-parchment/15 bg-ink px-3 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold/60"
                    />
                    <span className="text-xs text-parchment-dim/50">{fmtTime(draft.end)}</span>
                  </label>
                  <span className="font-sans text-xs text-parchment-dim/60">
                    {fmtTime(Math.max(draft.end - draft.start, 0))} long
                  </span>
                </div>

                <p className="mt-4 font-sans text-xs uppercase tracking-[0.2em] text-parchment-dim/60">
                  Captions — edit the text freely; empty a line to remove it
                </p>
                <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1">
                  {draft.captions.map((line, i) => (
                    <div key={line.start} className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-right font-sans text-xs text-sky/80">
                        {fmtTime(Math.max(line.start - draft.start, 0))}
                      </span>
                      <input
                        value={line.text}
                        onChange={(e) => {
                          const captions = [...draft.captions]
                          captions[i] = { ...line, text: e.target.value }
                          setDraft({ ...draft, captions })
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-parchment/15 bg-ink px-3 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold/60"
                      />
                    </div>
                  ))}
                  {draft.captions.length === 0 && (
                    <p className="font-sans text-sm text-parchment-dim/50">
                      No speech in this window — widen the start/end times.
                    </p>
                  )}
                </div>

                {editError && <p className="mt-3 font-sans text-sm text-rose">{editError}</p>}
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={submitEdit}
                    disabled={editBusy}
                    className="rounded-lg bg-gold px-4 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep disabled:opacity-50"
                  >
                    {editBusy ? "Starting…" : "Re-render clip →"}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(null)
                      setDraft(null)
                      setEditError(null)
                    }}
                    className="rounded-lg border border-parchment/20 px-4 py-2 font-sans text-sm text-parchment-dim transition hover:text-parchment"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {editing?.jobId === job.id && !draft && editError && (
              <p className="mt-3 font-sans text-sm text-rose">{editError}</p>
            )}
          </section>
        ))}
      </div>
    </main>
  )
}
