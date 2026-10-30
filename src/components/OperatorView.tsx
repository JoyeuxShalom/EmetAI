import { useEffect, useRef, useState } from "react"
import { search, parseReference } from "../lib/search"
import { SpeechListener, detectReference, speechSupported } from "../lib/listener"
import {
  normalize,
  refOf,
  loadBible,
  nextVerse,
  prevVerse,
  resolveParallel,
  resolveParallelRef,
  VERSIONS,
  type Bible,
  type Mappings,
  type Overrides,
  type Verse,
} from "../data/bible"
import type { OnlineBible } from "../data/online"
import { type AudioSource, LocalEar } from "../lib/localEar"
import { CONFIDENT, matchQuote, warmQuoteIndex } from "../lib/quoteMatch"
import { CommandGate } from "../lib/commandGate"
import { FAST_COMMAND_MS, SILENCE_MS, UtteranceAssembler } from "../lib/utterance"
import {
  isSpeaking,
  loadVoicePreference,
  saveVoicePreference,
  say,
  speechSupported as voiceOutputSupported,
  stopSpeaking,
  warmVoices,
  type VoiceGender,
} from "../lib/speech"
import { candidateRefs, findVerseFlexible } from "../lib/refResolve"
import {
  containsWakeWord,
  detectBareCommand,
  detectWakeCommand,
  type ControlAction,
  looksLikeInstruction,
  type WakeCommand,
} from "../lib/wakeWord"
import ListeningOrb, { ListeningBanner, type OrbState } from "./ListeningOrb"
import { api, type AgentAction, type AgentPlan, type BrainCard } from "../lib/api"
import { canAskAI, useAuth } from "../lib/auth"
import { track } from "../lib/usage"
import { navigate } from "../lib/router"

type Props = {
  bible: Bible | null
  primaryOnline: OnlineBible | null
  primaryLabel: string
  versionIds: string[]
  mappings: Mappings
  overrides: Overrides
  onChangeVersions: (ids: string[]) => void
  showPrimary: boolean
  onToggleShowPrimary: () => void
  onProject: (verse: Verse | null) => void
  onProjectCard: (card: BrainCard | null) => void
  nowShowing: Verse | null
  /** The answer currently on the projector, if one is showing. */
  liveCard: BrainCard | null
}

// `score` is how sure the paraphrase matcher was, 0-1. Showing it lets the
// operator judge a suggestion at a glance instead of taking it on faith —
// a guess at 0.63 and a certainty at 0.95 should not look identical.
type Detection = {
  key: string
  heard: string
  verse: Verse
  at: number
  score?: number
  /** Which language the utterance that produced this was spoken in. */
  lang?: string
  /** Heard in a second language too — the interpreter said the same verse. */
  confirmed?: boolean
}

/** How long the interpreter has to repeat the preacher's verse for the second
 *  hearing to count as confirmation of the first. An interpreter follows within
 *  a sentence or two; beyond this it is a fresh reading, not an echo. */
const CONFIRM_WINDOW_MS = 45000

// "gemini-auto" is the accurate ear: the utterance goes to Gemini, which
// transcribes it whatever language it is in. Everything else is a single
// fixed language — which is no use in a church where the preacher speaks
// Kinyarwanda and an interpreter answers in English.
type EarLang =
  | "gemini-auto"
  | "en-US" | "fr-FR"
  | "local-en" | "local-fr" | "local-rw"

// Quote detection listens in the EAR's language — the preacher may recite an
// English verse while the wall shows Bibiliya Yera. Two translations per
// language, because preachers quote from different Bibles.
const QUOTE_BIBLES_FOR_EAR: Record<EarLang, string[]> = {
  // With an interpreter, either language may carry the verse — the preacher
  // recites it in Kinyarwanda, the interpreter repeats it in English — so the
  // Gemini ear matches against all three rather than guessing one.
  "gemini-auto": ["by", "kjv", "ls1910"],
  "en-US": ["kjv", "web"],
  "local-en": ["kjv", "web"],
  "fr-FR": ["ls1910", "martin"],
  "local-fr": ["ls1910", "martin"],
  "local-rw": ["by"],
}

// A quote this confident outranks even a spoken reference — preachers
// sometimes announce the wrong number for the verse they are reciting.
const QUOTE_OVERRIDES_REF = CONFIDENT

// In automatic mode, the wall may not change faster than this. A congregation
// reading along needs the words to stay still long enough to be read.
const PROJECT_COOLDOWN_MS = 6000

// How long Emet keeps waiting after the wake word for the rest of a command.
// Short: a preacher who says "Emet" and then carries on preaching should be
// left alone, and a fragment kept longer than this belongs to a different
// sentence by the time the next one arrives.
const WAKE_AWAIT_MS = 8000

// Wake-free mode sends sentences to a model, so it needs a leash: no more
// than one plan every few seconds, and never the same sentence twice.
const AGENT_MIN_GAP_MS = 4000

// How long the browser waits after the local ear has ALREADY waited out
// 0.65s of silence server-side. Enough to join two finals that belong to one
// sentence, without paying for the same pause twice.
const LOCAL_EAR_SETTLE_MS = 700

// The remote ear has waited out its own silence AND spent ~2.5s on a round
// trip to Google before a final ever reaches the browser — measured, and flat
// in audio length, so it is a fixed cost that cannot be tuned away. Making the
// operator wait a further 700ms on top was paying for the same pause three
// times. Just long enough to join two finals that arrive together.
const REMOTE_EAR_SETTLE_MS = 120

// The language the trigger lane listens in. Commands are spoken in English
// even in a Kinyarwanda service - "Emet, John three sixteen" - and Chrome's
// recogniser has no Kinyarwanda at all, so asking it for one would only
// produce noise. Free text still goes to Gemini, in whatever language it was
// actually spoken.
const FAST_LANE_LANG = "en-US"

const EAR_LANG_CODE: Record<EarLang, "en" | "fr" | "rw"> = {
  // Answers default to English for the mixed ear; a spoken question in
  // Kinyarwanda still gets a Kinyarwanda answer, because the agent replies in
  // whatever language it was asked in.
  "gemini-auto": "en",
  "en-US": "en",
  "local-en": "en",
  "fr-FR": "fr",
  "local-fr": "fr",
  "local-rw": "rw",
}

/** Is this transcript too poor to search scripture with?
 *
 *  Speech recognition does not fail by going quiet. Whisper in particular
 *  repeats itself when it hears nothing intelligible ("amen amen amen amen")
 *  and invents filler over background noise. Handing that to the matcher is
 *  how a projector ends up cycling through verses nobody asked for, so it is
 *  treated as silence. Spoken commands are unaffected — they are checked
 *  before this, and are short by nature. */
function tooPoorToSearch(text: string): boolean {
  const words = normalize(text).split(" ").filter(Boolean)
  if (words.length < 6) return true // too little to identify a verse safely
  const distinct = new Set(words)
  if (distinct.size / words.length < 0.5) return true // mostly repetition
  const longest = words.reduce((n: number, w: string) => Math.max(n, w.length), 0)
  return longest < 3 // nothing but fragments
}

/** Soft two-tone chime — audible confirmation that Emet woke up. */
function playChime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.07, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4)
    osc.start()
    osc.frequency.setValueAtTime(1318.5, ctx.currentTime + 0.12)
    osc.stop(ctx.currentTime + 0.45)
    osc.onended = () => void ctx.close()
  } catch {
    /* audio not allowed — the visual banner still confirms */
  }
}

function MiniVerseCard({
  title,
  verse,
  live,
}: {
  title: string
  verse: Verse | null
  live?: boolean
}) {
  return (
    <div
      className={`relative flex-1 overflow-hidden rounded-xl border bg-ink p-4 ${
        live ? "border-gold/50" : "border-sky/30"
      }`}
    >
      <div className="beam" />
      <div className="relative z-10">
        <div className="flex items-center justify-between">
          <p
            className={`font-sans text-[0.65rem] uppercase tracking-[0.3em] ${
              live ? "text-gold/80" : "text-sky/80"
            }`}
          >
            {title}
          </p>
          {live && verse && (
            <span className="rounded bg-gold/15 px-1.5 py-0.5 font-sans text-[0.6rem] font-medium uppercase tracking-widest text-gold">
              ● Live
            </span>
          )}
        </div>
        {verse ? (
          <div className="mt-3 text-center">
            <p className="font-sans text-xs uppercase tracking-[0.25em] text-sky/80">{refOf(verse)}</p>
            <p className="mx-auto mt-2 line-clamp-4 max-w-[36ch] font-display text-[0.95rem] leading-snug text-parchment">
              {verse.text}
            </p>
            <p className="mt-2 font-sans text-[0.6rem] uppercase tracking-[0.25em] text-parchment-dim/50">
              {verse.translation}
            </p>
          </div>
        ) : (
          <p className="mt-6 text-center font-sans text-sm text-parchment-dim/40">
            {live ? "Screen is idle" : "Nothing staged"}
          </p>
        )}
      </div>
    </div>
  )
}

function MiniBrainCard({
  card,
  title,
  live,
}: {
  card: BrainCard
  title: string
  live?: boolean
}) {
  return (
    <div
      className={`relative flex-1 overflow-hidden rounded-xl border bg-ink p-4 ${
        live ? "border-gold/50" : "border-sky/30"
      }`}
    >
      <div className="beam" />
      <div className="relative z-10">
        <div className="flex items-center justify-between">
          <p
            className={`font-sans text-[0.65rem] uppercase tracking-[0.3em] ${
              live ? "text-gold/80" : "text-sky/80"
            }`}
          >
            {title}
          </p>
          {live && (
            <span className="rounded bg-gold/15 px-1.5 py-0.5 font-sans text-[0.6rem] font-medium uppercase tracking-widest text-gold">
              ● Live
            </span>
          )}
        </div>
        <div className="mt-3 text-center">
          <p className="font-display text-base text-gold">{card.title}</p>
          {card.subtitle && (
            <p className="mt-1 font-sans text-[0.65rem] uppercase tracking-[0.2em] text-sky/70">
              {card.subtitle}
            </p>
          )}
          <p className="mx-auto mt-2 line-clamp-3 max-w-[40ch] font-display text-sm leading-snug text-parchment">
            {card.body[0]}
          </p>
          <p className="mt-2 font-sans text-[0.6rem] uppercase tracking-[0.25em] text-parchment-dim/50">
            {card.source}
          </p>
        </div>
      </div>
    </div>
  )
}

export default function OperatorView({
  bible,
  primaryOnline,
  primaryLabel,
  versionIds,
  mappings,
  overrides,
  onChangeVersions,
  showPrimary,
  onToggleShowPrimary,
  onProject,
  onProjectCard,
  nowShowing,
  liveCard,
}: Props) {
  // The ear is part of every plan — EmetAI is an AI product. AI *answers*
  // (definitions, history) are what the paid plans add.
  const { user } = useAuth()
  const aiEnabled = user?.ai ?? false
  const askEnabled = canAskAI(user)

  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [onlineHit, setOnlineHit] = useState<{ q: string; verses: Verse[] } | null>(null)

  // PewBeam-style workflow state
  const [staged, setStaged] = useState<Verse | null>(null)
  const [stagedCard, setStagedCard] = useState<BrainCard | null>(null)
  const [asking, setAsking] = useState(false)
  const [queue, setQueue] = useState<Verse[]>([])
  const [detections, setDetections] = useState<Detection[]>([])
  const [transcript, setTranscript] = useState<{ text: string; role: string }[]>([])

  // The AI ear
  const [listening, setListening] = useState(false)
  const [autoMode, setAutoMode] = useState(false)
  const [earLang, setEarLang] = useState<EarLang>("en-US")
  // Where the sound comes from. A service watched on THIS laptop cannot be
  // heard through the microphone: the browser's echo cancellation exists to
  // remove sound the computer is making, so it strips the sermon out. Sharing
  // the computer's audio instead gives a clean feed with no room noise at all.
  const [audioSource, setAudioSource] = useState<AudioSource>("microphone")
  const [interimLine, setInterimLine] = useState("")
  const [micError, setMicError] = useState<string | null>(null)
  const [quoteBibles, setQuoteBibles] = useState<Bible[]>([])
  const lastProjectedRef = useRef<{ key: string; at: number }>({ key: "", at: 0 })
  // Remembered so "show that again" can undo a blanked screen.
  const lastLive = useRef<Verse | null>(null)
  // Rolling context: references often straddle two utterances
  // ("...dusome mu gitabo cya Yohana" / "umurongo wa kabiri").
  const lastFinalRef = useRef("")

  // How loud the room is right now, and therefore how the orb moves.
  const [micLevel, setMicLevel] = useState(0)
  const orbState: OrbState = asking
    ? "thinking"
    : !listening
      ? "idle"
      : micLevel > 0.06 || interimLine.length > 0
        ? "hearing"
        : "listening"

  // The "Emet" wake word — hands-free commands, on by default while listening.
  const [wakeEnabled, setWakeEnabled] = useState(true)
  const [wakeStatus, setWakeStatus] = useState<string | null>(null)
  const earRef = useRef<LocalEar | null>(null)
  // Reassembles the ear's fragments into whole sentences. Held in a ref so the
  // wake word can shorten its silence window without rebuilding the ear.
  const utteranceRef = useRef<UtteranceAssembler | null>(null)
  const gate = useRef(new CommandGate())
  // —— The fast lane ——
  // The Gemini ear is accurate but a command spoken into it waits out the
  // silence window AND a round trip to Google: about three seconds before a
  // verse moves. That is slower than a good operator with a keyboard, which
  // is the whole gap this product exists to close.
  //
  // So the browser's own recogniser runs ALONGSIDE it, purely as a trigger.
  // It is never displayed and never feeds verse matching — it exists to spot
  // "Emet, John three sixteen" or "next verse" while the words are still
  // being spoken, act on them at once, and flush the Gemini utterance early
  // so the accurate transcript arrives sooner too.
  //
  // It runs in the BROWSER, which is what makes it affordable: the last
  // attempt at a fast lane decoded Whisper on the server and starved the
  // network call that mattered. This one costs the server nothing.

  // "Emet…" heard but the command was unfinished — stay awake and stitch the
  // following utterances onto it ("…a word called" / "elohimi").
  const wakeAwait = useRef<{ parts: string[]; at: number } | null>(null)
  const wakeAwaitTimer = useRef<number | null>(null)
  // This service's thread with Emet, so "say more about that" and "go back to
  // what you said about grace" have something to refer to.
  const conversationId = useRef("")
  // The answer currently being streamed, so a new question can abandon it.
  const askAbort = useRef<AbortController | null>(null)
  const lastAgentAsk = useRef<{ text: string; at: number }>({ text: "", at: 0 })

  // Emet's own voice. Off by default: a laptop that suddenly starts
  // talking during a service is worse than one that stays quiet, so this
  // is the operator's deliberate choice.
  const [voiceGender, setVoiceGender] = useState<VoiceGender>("off")
  useEffect(() => {
    setVoiceGender(loadVoicePreference())
    warmVoices()
  }, [])
  useEffect(() => () => stopSpeaking(), [])

  // —— The service record, and how EmetAI learns from it ——
  // Everything heard during a service is filed under one id so it can be read
  // back afterwards. Without this, "it got that wrong" is an impression nobody
  // can act on; with it, it is a row the operator can correct in one click —
  // and a correction is in the ear's vocabulary from the next utterance on.
  const serviceRef = useRef<string>("")
  const seqRef = useRef(0)
  // Which language the ear says the current utterance was spoken in. Set by
  // the transport, read when a verse is detected — see CONFIRM_WINDOW_MS.
  const lastLangRef = useRef<string>("")
  // Who the ear says spoke the current utterance — "preacher",
  // "interpreter", "speaker 1/2", or "both" when it heard two people at
  // once and refused to guess between them.
  const lastRoleRef = useRef<string>("")
  // Whether the ear judged the current utterance to be an instruction. Set by
  // the transport, consumed once when the sentence settles.
  const lastRequestRef = useRef<boolean>(false)
  // Which transcript line is being corrected, and what the operator has typed.
  const [fixing, setFixing] = useState<{ index: number; text: string } | null>(null)
  const [learned, setLearned] = useState<string | null>(null)

  /** File one heard line, and what EmetAI did with it. Never blocks the ear:
   *  a failed write must not cost the congregation a verse. */
  function recordLine(
    heard: string,
    action: string,
    result = "",
    score = 0,
    lang = ""
  ) {
    const id = serviceRef.current
    if (!id || !heard.trim()) return
    seqRef.current += 1
    void api
      .logServiceLine(id, {
        seq: seqRef.current,
        heard,
        lang,
        action,
        result,
        score,
        speaker: lastRoleRef.current,
      })
      .catch(() => {})
  }

  /** Close the service record when the microphone closes. */
  function closeService() {
    const id = serviceRef.current
    serviceRef.current = ""
    if (id) void api.endService(id).catch(() => {})
  }

  /** The operator says what should have been heard. This is the whole loop. */
  async function teach(heard: string, correct: string) {
    const fixed = correct.trim()
    if (!fixed || fixed === heard.trim()) {
      setFixing(null)
      return
    }
    try {
      const res = await api.teachCorrection({
        heard,
        correct: fixed,
        service_id: serviceRef.current,
      })
      setLearned(
        res.learned.length
          ? `Learned: ${res.learned.filter((w) => w !== "alias").join(", ") || "the correction"}`
          : "Already knew that one — noted again"
      )
    } catch {
      setLearned("Could not save that correction.")
    }
    setFixing(null)
    window.setTimeout(() => setLearned(null), 4000)
  }

  // The administrator's master switch. Until this is on, the microphone does
  // not open and the agent is never consulted. The server enforces it too —
  // this copy only exists so the Studio can explain itself instead of
  // failing silently.
  const [voice, setVoice] = useState({ enabled: false, agent: false, loaded: false })
  useEffect(() => {
    let alive = true
    void api
      .voiceStatus()
      .then((s) => alive && setVoice({ enabled: s.enabled, agent: s.agent, loaded: true }))
      .catch(() => alive && setVoice({ enabled: false, agent: false, loaded: true }))
    return () => {
      alive = false
    }
  }, [])

  // Switched off mid-service? Close the microphone rather than leave it open.
  useEffect(() => {
    if (voice.loaded && !voice.enabled && listening) setListening(false)
  }, [voice.loaded, voice.enabled, listening])

  const isOnline = primaryOnline !== null
  const trimmed = query.trim()
  const parsedRef = isOnline && trimmed ? parseReference(trimmed) : null
  const onlineResults = onlineHit && onlineHit.q === trimmed ? onlineHit.verses : []
  const searching = isOnline && parsedRef !== null && (!onlineHit || onlineHit.q !== trimmed)
  let localResults = !isOnline && bible ? search(bible, query) : []
  // Typed a reference that doesn't exist in this Bible's numbering?
  // Re-interpret it through the other tradition (Joel 2:28 <-> Yoweli 3:1).
  if (!isOnline && bible && localResults.length === 0 && trimmed) {
    const pr = parseReference(trimmed)
    if (pr && pr.verse !== null) {
      const v = findVerseFlexible(
        bible, versionIds[0], pr.bookNr, pr.chapter, pr.verse, mappings, overrides
      )
      if (v) localResults = [v]
    }
  }
  const results = isOnline ? onlineResults : localResults

  const localVersions = VERSIONS.filter((v) => v.source === "local")
  const onlineVersions = VERSIONS.filter((v) => v.source === "youversion")

  // Chapter browser: verses of the staged (or live) chapter, local primary only.
  const browseTarget = staged ?? nowShowing
  const chapterVerses =
    !isOnline && bible && browseTarget && !trimmed
      ? bible.verses.filter(
          (v) => v.bookNr === browseTarget.bookNr && v.chapter === browseTarget.chapter
        )
      : []

  function goLive(v: Verse | null) {
    if (!v) return
    lastProjectedRef.current = {
      key: `${v.bookNr}:${v.chapter}:${v.verse}`,
      at: Date.now(),
    }
    onProject(v)
    track("verse_shown")
    lastLive.current = v
    setStaged(null)
    setStagedCard(null)
  }

  function stage(v: Verse) {
    setStaged(v)
    setStagedCard(null)
  }

  function enqueue(v: Verse) {
    setQueue((q) => (q.some((x) => refOf(x) === refOf(v)) ? q : [...q, v]))
  }

  /** Resolve a heard reference against the primary version (both traditions). */
  async function resolveHeardRef(ref: {
    bookNr: number
    book: string
    chapter: number
    verse: number | null
  }): Promise<Verse | null> {
    try {
      if (primaryOnline) {
        const tradition = VERSIONS.find((x) => x.id === versionIds[0])?.tradition ?? "kjv"
        for (const c of candidateRefs(tradition, ref.bookNr, ref.chapter, ref.verse ?? 1, overrides)) {
          const v = await primaryOnline.getVerse(c.bookNr, ref.book, c.chapter, c.verse)
          if (v) return v
        }
        return null
      }
      if (bible) {
        return findVerseFlexible(
          bible, versionIds[0], ref.bookNr, ref.chapter, ref.verse ?? 1, mappings, overrides
        )
      }
    } catch {
      /* offline / API error */
    }
    return null
  }

  /** Carry out a plan the agent produced.
   *
   *  The agent never touches the app itself — it returns an ordered list of
   *  actions and they are performed here, through exactly the same functions
   *  the buttons use. Anything not in this switch is ignored, so a confused
   *  or manipulated model cannot reach past these four verbs. */
  async function runPlan(plan: AgentPlan) {
    if (plan.say) announce(`Emet: ${plan.say}`)
    let projectedOne = false

    for (const action of plan.actions) {
      if (action.type === "versions") {
        // "Kinyarwanda and English side by side" lands here: the projector
        // already renders one column per selected translation.
        onChangeVersions(action.ids)
        continue
      }

      if (action.type === "control") {
        runControl(action.action as ControlAction)
        continue
      }

      if (action.type === "answer") {
        await askBrain(action.query, "auto", "", true, false, action.mode, action.depth)
        continue
      }

      // Verses. The agent names references in English; resolving them here
      // means they render in whichever translations are on screen, so one
      // reference covers every language at once.
      for (const ref of action.refs) {
        // Models name ranges — "Ephesians 2:8-9" — and the projector shows one
        // verse at a time. Open at the first; "next verse" walks the rest.
        const parsed = parseReference(ref.replace(/\s*[-–—]\s*\d+\s*$/, ""))
        if (!parsed) continue
        const verse = await resolveHeardRef({
          bookNr: parsed.bookNr,
          book: parsed.book,
          chapter: parsed.chapter,
          verse: parsed.verse ?? 1,
        })
        if (!verse) continue
        if (!projectedOne) {
          projectedOne = true
          lastProjectedRef.current = {
            key: `${verse.bookNr}:${verse.chapter}:${verse.verse}`,
            at: Date.now(),
          }
          goLive(verse)
        } else {
          // The rest wait in the service list, ready for "next".
          setQueue((q) => (q.some((v) => refOf(v) === refOf(verse)) ? q : [...q, verse]))
        }
      }
    }

    if (projectedOne && plan.actions.some((a) => a.type === "verses")) {
      const extra = plan.actions
        .filter((a): a is Extract<AgentAction, { type: "verses" }> => a.type === "verses")
        .reduce((n, a) => n + a.refs.length, 0)
      if (extra > 1) {
        setWakeStatus(
          `${plan.say || "Emet"} — ${extra - 1} more in the queue, say “next verse”`
        )
      }
    }
  }

  /** Ask the agent to work out what a sentence meant.
   *
   *  Only reached when the instant parser found nothing, so ordinary commands
   *  never pay for a model round trip. */
  async function askAgent(transcript: string) {
    if (!voice.enabled || !voice.agent) return false
    setAsking(true)
    setWakeStatus("Emet is working that out…")
    try {
      const plan = await api.voicePlan({
        transcript,
        showing: nowShowing
          ? `${nowShowing.book} ${nowShowing.chapter}:${nowShowing.verse}`
          : "",
        versions: versionIds,
        lang: EAR_LANG_CODE[earLang],
      })
      if (!plan.actions.length) {
        // The agent decided this was preaching, not an instruction. Say
        // nothing and get out of the way — that is the correct outcome far
        // more often than not.
        setWakeStatus(plan.say ? `Emet: ${plan.say}` : null)
        return false
      }
      await runPlan(plan)
      return true
    } catch (err) {
      setWakeStatus(err instanceof Error ? err.message : "Emet could not work that out.")
      return false
    } finally {
      setAsking(false)
    }
  }

  /** Stop waiting for the rest of a command.
   *
   *  This has to be reachable from a timer, not only from a completed
   *  command: a preacher who says "Emet" and then changes his mind must not
   *  leave the panel reading "finish the command…" for the rest of the
   *  service. That frozen banner is what looked like a crash. */
  /** Say something and show it. One call so the two can never drift apart —
   *  and so every spoken line is one the operator can also read. */
  function announce(line: string | null) {
    setWakeStatus(line)
    if (line) say(line.replace(/^Emet:\s*/i, ""), earLang, voiceGender)
  }

  function clearWakeAwait(status?: string | null) {
    wakeAwait.current = null
    if (wakeAwaitTimer.current !== null) {
      window.clearTimeout(wakeAwaitTimer.current)
      wakeAwaitTimer.current = null
    }
    if (status !== undefined) setWakeStatus(status)
  }

  /** Keep listening for the rest of a half-spoken command. */
  function armWakeAwait(fragment: string) {
    // Only the last two fragments are kept. Stitching a minute of preaching
    // together produces a "command" nobody actually spoke, and that is how
    // Emet ended up answering questions out of thin air.
    const parts = [...(wakeAwait.current?.parts ?? []), fragment].slice(-2)
    wakeAwait.current = { parts, at: Date.now() }
    if (wakeAwaitTimer.current !== null) window.clearTimeout(wakeAwaitTimer.current)
    wakeAwaitTimer.current = window.setTimeout(() => {
      wakeAwaitTimer.current = null
      wakeAwait.current = null
      setWakeStatus("Emet stopped waiting — say “Emet” again.")
    }, WAKE_AWAIT_MS)
  }

  useEffect(() => () => clearWakeAwait(), [])

  /** Ask the brain and show the answer — the "Emet find me…" path.
   *
   *  The answer is streamed, so the title reaches the screen the moment it
   *  exists and the rest fills in underneath. Waiting for a finished card is
   *  what made Emet feel frozen: several seconds of nothing, then everything
   *  at once. Only one answer is ever in flight — asking again abandons the
   *  previous one rather than letting two answers race onto the projector. */
  async function askBrain(
    q: string,
    kind: "definition" | "knowledge" | "auto",
    scope: "hebrew" | "greek" | "",
    live: boolean,
    recall = false,
    // How to pitch it: 'general' stays short and factual, 'spiritual' gives
    // theology room. The agent decides; typed questions leave it to the server.
    mode: "general" | "spiritual" | "auto" = "auto",
    depth: "brief" | "full" = "brief"
  ) {
    askAbort.current?.abort()
    const abort = new AbortController()
    askAbort.current = abort

    setAsking(true)
    setWakeStatus(recall ? `Emet is going back to “${q}”…` : `Emet is finding “${q}”…`)
    track("brain_ask")

    // Built up field by field as the events arrive.
    const card: BrainCard = { title: q, subtitle: "", body: [], points: [], source: "Emet AI" }
    let painted = 0
    let anything = false

    // The projector redraws on a BroadcastChannel message; at one message per
    // token it would do nothing else. Twelve frames a second reads as live.
    const paint = (force: boolean) => {
      const now = Date.now()
      if (!force && now - painted < 80) return
      painted = now
      const snapshot: BrainCard = { ...card, body: [...card.body], points: [...(card.points ?? [])] }
      if (live) onProjectCard(snapshot)
      else setStagedCard(snapshot)
    }

    try {
      for await (const event of api.brainStream(
        {
          q, kind, scope, mode, depth, recall,
          lang: EAR_LANG_CODE[earLang],
          conversationId: conversationId.current,
        },
        abort.signal
      )) {
        if (event.type === "open") {
          conversationId.current = event.conversationId
          continue
        }
        if (event.type === "error") throw new Error(event.message)
        if (event.type === "done") {
          if (live) {
            setStagedCard(null)
            onProjectCard(event.card)
            track("card_shown")
          } else {
            setStaged(null)
            setStagedCard(event.card)
          }
          setWakeStatus(
            live
              ? `Showing: ${event.card.title} · ${event.card.source}`
              : `Staged: ${event.card.title} · ${event.card.source} — Ctrl+Enter shows it`
          )
          return
        }

        // A slot event carries its field in full, so this is an assignment
        // rather than an append — a dropped event cannot corrupt the text.
        if (event.slot === "title") card.title = event.text
        else if (event.slot === "subtitle") card.subtitle = event.text
        else if (event.slot === "body") card.body[event.index] = event.text
        else (card.points ??= [])[event.index] = event.text

        if (!anything) {
          anything = true
          if (live) setStagedCard(null)
          else setStaged(null)
        }
        paint(event.done)
      }
      // The stream ended without a `done` event — the connection dropped.
      if (anything) {
        paint(true)
        setWakeStatus(`Showing: ${card.title} — the answer was cut short`)
      } else {
        setWakeStatus("Emet could not find an answer.")
      }
    } catch (err) {
      if (abort.signal.aborted) return // superseded by a newer question
      setWakeStatus(err instanceof Error ? err.message : "Emet could not find an answer.")
      if (!anything && live) onProjectCard(null)
    } finally {
      if (askAbort.current === abort) {
        askAbort.current = null
        setAsking(false)
      }
    }
  }

  /** Perform a spoken control. Everything the operator's hands can do. */
  function runControl(action: ControlAction) {
    switch (action) {
      case "next":
      case "prev": {
        if (!nowShowing) {
          setWakeStatus("Emet: nothing is live yet — show a verse first")
          return
        }
        announce(action === "next" ? "Emet: next verse" : "Emet: previous verse")
        void (action === "next" ? goNext() : goPrev())
        return
      }
      case "blank":
        announce("Emet: screen cleared")
        lastLive.current = nowShowing ?? lastLive.current
        onProjectCard(null)
        onProject(null)
        return
      case "again": {
        const back = lastLive.current
        if (!back) {
          setWakeStatus("Emet: nothing to bring back yet")
          return
        }
        setWakeStatus(`Emet: showing ${refOf(back)} again`)
        goLive(back)
        return
      }
      case "golive":
        if (stagedCard) {
          onProjectCard(stagedCard)
          setStagedCard(null)
          setWakeStatus("Emet: answer on the screen")
        } else if (staged) {
          setWakeStatus(`Emet: ${refOf(staged)} is live`)
          goLive(staged)
        } else {
          setWakeStatus("Emet: nothing is staged to show")
        }
        return
      case "queue": {
        const v = staged ?? nowShowing
        if (!v) {
          setWakeStatus("Emet: nothing to add yet")
          return
        }
        enqueue(v)
        track("queue_used")
        setWakeStatus(`Emet: ${refOf(v)} added to the list`)
        return
      }
      case "queueClear":
        setQueue([])
        setWakeStatus("Emet: service list cleared")
        return
      case "queueNext": {
        const [head, ...rest] = queue
        if (!head) {
          setWakeStatus("Emet: the service list is empty")
          return
        }
        setQueue(rest)
        setWakeStatus(`Emet: ${refOf(head)} from the list`)
        goLive(head)
        return
      }
      case "showPrimary":
      case "hidePrimary":
        if (showPrimary === (action === "showPrimary")) {
          setWakeStatus(`Emet: the first translation is already ${showPrimary ? "shown" : "hidden"}`)
          return
        }
        onToggleShowPrimary()
        setWakeStatus(
          action === "showPrimary" ? "Emet: first translation shown" : "Emet: first translation hidden"
        )
        return
      case "auto":
      case "suggest":
        setAutoMode(action === "auto")
        setWakeStatus(
          action === "auto"
            ? "Emet: automatic — verses go straight to the screen"
            : "Emet: suggesting — verses wait in Preview"
        )
        return
      case "display":
        track("display_opened")
        window.open("#display", "emetai-display")
        announce("Emet: projector window opened")
        return
      case "stop":
        announce("Emet: no longer listening")
        setListening(false)
        return
      case "listen":
        setMicError(null)
        announce("Emet: listening")
        setListening(true)
        return

      // Moving about the app. "Emet, open my account" used to do nothing at
      // all — there was no navigation action for a voice command to reach.
      case "goStudio":
        announce("Emet: Studio")
        navigate("#/app")
        return
      case "goAccount":
        announce("Emet: opening your account")
        navigate("#/account")
        return
      case "goAdmin":
        announce("Emet: opening admin")
        navigate("#/admin")
        return
      case "goClips":
        announce("Emet: opening clips")
        navigate("#/clips")
        return
      case "goPlans":
        announce("Emet: opening the plans")
        navigate("#/account")
        return
    }
  }

  function wakeSig(cmd: WakeCommand): string {
    switch (cmd.intent) {
      case "scripture":
        return `s:${cmd.ref.bookNr}:${cmd.ref.chapter}:${cmd.ref.verse}`
      case "define":
        return `d:${cmd.scope}:${cmd.term}`
      case "knowledge":
        return `k:${cmd.topic}`
      case "control":
        return `c:${cmd.action}`
      case "goto":
        return `g:${cmd.verse}`
      case "gotoChapter":
        return `gc:${cmd.chapter}:${cmd.verse}`
      case "version":
        return `v:${cmd.slot}:${cmd.version}`
      case "recall":
        return `r:${cmd.topic}`
    }
  }

  /** Execute an "Emet …" command. Wake commands bypass Suggest mode — the
   *  preacher asked out loud, so the answer goes straight to the wall. */
  function handleWakeCommand(
    cmd: WakeCommand,
    isFinal: boolean,
    source: "ear" | "fast" = "ear"
  ): boolean {

    // Questions fire once, on the committed utterance (the flush makes that
    // near-instant); references and controls act on interims for speed.
    if ((cmd.intent === "define" || cmd.intent === "knowledge") && !isFinal) return true

    if (isFinal) recordLine(cmd.heard ?? "", "command", cmd.intent)
    // Whether this runs at all — one ear echoing itself, or the accurate ear
    // repeating what the trigger lane already did. See src/lib/commandGate.ts.
    if (
      !gate.current.admit({
        sig: wakeSig(cmd),
        movement:
          cmd.intent === "goto" ||
          cmd.intent === "gotoChapter" ||
          (cmd.intent === "control" && (cmd.action === "next" || cmd.action === "prev")),
        control: cmd.intent === "control",
        source,
        now: Date.now(),
      })
    ) {
      return true
    }
    playChime()
    track("wake_command")

    if (cmd.intent === "control") {
      runControl(cmd.action)
      return true
    }

    if (cmd.intent === "gotoChapter") {
      if (!nowShowing) {
        setWakeStatus(`Emet heard “chapter ${cmd.chapter}” but no book is live yet`)
        return true
      }
      const target = { ...nowShowing, chapter: cmd.chapter, verse: cmd.verse ?? 1 }
      setWakeStatus(`Emet: ${nowShowing.book} ${cmd.chapter}:${cmd.verse ?? 1}`)
      void (async () => {
        const verse = await resolveHeardRef({
          bookNr: nowShowing.bookNr,
          book: nowShowing.book,
          chapter: target.chapter,
          verse: target.verse,
        })
        if (verse) goLive(verse)
        else setWakeStatus(`Emet: ${nowShowing.book} has no chapter ${cmd.chapter}`)
      })()
      return true
    }

    if (cmd.intent === "version") {
      const version = VERSIONS.find((v) => v.id === cmd.version)
      if (!version) return true
      const ids = [...versionIds]
      if (cmd.slot === "primary") ids[0] = cmd.version
      else if (!ids.includes(cmd.version)) ids[1] = cmd.version
      onChangeVersions(ids)
      setWakeStatus(
        cmd.slot === "primary"
          ? `Emet: now showing ${version.label}`
          : `Emet: added ${version.label}`
      )
      return true
    }

    if (cmd.intent === "goto") {
      if (!nowShowing) {
        setWakeStatus(`Emet heard “verse ${cmd.verse}” but no chapter is live yet`)
        return true
      }
      setWakeStatus(`Emet: ${nowShowing.book} ${nowShowing.chapter}:${cmd.verse}`)
      void (async () => {
        const verse = await resolveHeardRef({
          bookNr: nowShowing.bookNr,
          book: nowShowing.book,
          chapter: nowShowing.chapter,
          verse: cmd.verse,
        })
        if (verse) {
          lastProjectedRef.current = {
            key: `${verse.bookNr}:${verse.chapter}:${verse.verse}`,
            at: Date.now(),
          }
          goLive(verse) // same path as every other projection, so "again" works
        } else {
          setWakeStatus(`Emet: ${nowShowing.book} ${nowShowing.chapter} has no verse ${cmd.verse}`)
        }
      })()
      return true
    }

    if (cmd.intent === "scripture") {
      const label = `${cmd.ref.book} ${cmd.ref.chapter}${cmd.ref.verse ? ":" + cmd.ref.verse : ""}`
      setWakeStatus(`Emet: showing ${label}`)
      void (async () => {
        const verse = await resolveHeardRef(cmd.ref)
        if (!verse) {
          setWakeStatus(`Emet heard “${cmd.heard}” but couldn’t find ${label}.`)
          return
        }
        lastProjectedRef.current = {
          key: `${verse.bookNr}:${verse.chapter}:${verse.verse}`,
          at: Date.now(),
        }
        onProject(verse)
        setDetections((d) => [
          { key: `${verse.bookNr}:${verse.chapter}:${verse.verse}`, heard: `Emet: ${cmd.heard}`, verse, at: Date.now() },
          ...d,
        ].slice(0, 8))
      })()
      return true
    }

    // Scripture and screen control are free; asking the AI a question is not.
    if (!askEnabled) {
      setWakeStatus(
        "Emet heard you, but AI answers are part of the Pro plan — open Account to upgrade."
      )
      return true
    }
    if (cmd.intent === "recall") {
      // Answered from this service's own thread — instant, and it costs the
      // church nothing to put an earlier answer back on the wall.
      void askBrain(cmd.topic, "auto", "", true, true)
      return true
    }
    if (cmd.intent === "define") {
      void askBrain(cmd.term, "definition", cmd.scope, true)
      return true
    }
    void askBrain(cmd.topic, "knowledge", "", true)
    return true
  }

  // Everything the ear does with a transcript lives here, and this function is
  // rebuilt on every render so it always sees current state. The microphone
  // effect below reaches it through a ref — never by closing over it — because
  // depending on state would tear the microphone down and rebuild it every
  // time a verse went on screen, and the next sentence would be lost.
  const onTranscriptRef = useRef<(text: string, isFinal: boolean) => void>(() => {})

  // What the fast lane does with what it hears. Deliberately narrow: it may
  // only act on something that already parses as a complete command. It never
  // writes to the transcript, never reaches quote matching, and never asks the
  // agent — so a mis-hearing of Kinyarwanda cannot put a wrong verse on a wall
  // or invent a line in the record. The worst it can do is nothing.
  const onFastHintRef = useRef<(text: string) => void>(() => {})
  onFastHintRef.current = (text: string) => {
    if (!wakeEnabled || isSpeaking()) return
    const cmd = detectWakeCommand(text) ?? detectBareCommand(text)
    if (!cmd) return
    // Questions need the accurate transcript — the fast lane is not good
    // enough to ask the agent with, and a wrong question wastes an API call
    // and the operator's attention.
    if (cmd.intent === "define" || cmd.intent === "knowledge") {
      earRef.current?.flush()   // still worth cutting the utterance early
      return
    }
    if (handleWakeCommand(cmd, true, "fast")) {
      // The words are already spoken and acted on; commit the utterance now
      // rather than letting it sit out the silence window.
      earRef.current?.flush()
    }
  }

  onTranscriptRef.current = (text: string, isFinal: boolean) => {
        // Emet must never hear itself. The microphone stays open while it
        // speaks, so without this the confirmation it just said comes back in
        // as a command — "Emet: opening your account" heard, parsed, obeyed,
        // and round it goes. Everything spoken while Emet is talking, and for
        // a moment after, is discarded.
        if (isSpeaking()) return

        // Join with the previous utterance so split references still land,
        // and act on interims too — speed matters more than tidiness here.
        const context = `${lastFinalRef.current} ${text}`.slice(-300)
        if (isFinal) {
          setTranscript((lines) => [
            ...lines.slice(-40),
            { text: text.trim(), role: lastRoleRef.current },
          ])
          // Filed as "ignored" now; if this line goes on to produce a verse,
          // a command or an answer, that is recorded as its own row below.
          // A line that was heard and did nothing is the most useful row of
          // all when reviewing why a service went wrong.
          recordLine(text.trim(), "ignored")
          setInterimLine("")
          lastFinalRef.current = text.trim().slice(-200)
        } else {
          setInterimLine(text.slice(-120))
        }

        // —— Voice commands take absolute priority ——
        if (wakeEnabled) {
          // "Emet …" — the explicit wake word, anywhere in the utterance.
          let wake = detectWakeCommand(context)
          // Still awake from an unfinished command? Stitch this utterance on.
          // The window is short on purpose — a stale fragment joined to a new
          // sentence invents commands that were never spoken.
          const awaiting =
            wakeAwait.current && Date.now() - wakeAwait.current.at < WAKE_AWAIT_MS
              ? wakeAwait.current
              : null
          if (!awaiting && wakeAwait.current) clearWakeAwait()
          if (!wake && awaiting) {
            wake = detectWakeCommand(`emet ${awaiting.parts.join(" ")} ${text}`.slice(-400))
          }
          if (wake) {
            // Heard mid-utterance: commit NOW rather than waiting out the
            // full silence window — a command should not sit on a pause.
            if (!isFinal) {
              earRef.current?.flush()
              // A parsed wake command is finished; anything else after the
              // name still gets the ordinary short window.
              utteranceRef.current?.expectCommand(
                wake.intent === "control" || wake.intent === "goto" ||
                wake.intent === "gotoChapter" || wake.intent === "version"
                  ? FAST_COMMAND_MS
                  : undefined
              )
            }
            const handled = handleWakeCommand(wake, isFinal)
            // Don't let the command bleed into the next utterance's context.
            if (isFinal) {
              lastFinalRef.current = ""
              clearWakeAwait()
            }
            if (handled) return
          } else if (isFinal && (containsWakeWord(text) || awaiting)) {
            // Emet was named but no known command matched. Two possibilities:
            // the sentence is still being spoken, or it is a request the
            // instant parser has no pattern for ("verses about faith in
            // Kinyarwanda and English side by side").
            //
            // A whole sentence with a verb in it is worth handing to the
            // agent; a trailing fragment is not, so short utterances still
            // just wait for the rest. This ordering is the point of the whole
            // design — the model is consulted last, never on the fast path.
            const stitched = `${awaiting ? awaiting.parts.join(" ") + " " : ""}${text}`.trim()
            if (askEnabled && voice.agent && stitched.split(/\s+/).length >= 4) {
              clearWakeAwait()
              lastFinalRef.current = ""
              playChime()
              void askAgent(stitched)
              return
            }
            // Still a fragment — stay awake for the next breath and say so.
            // armWakeAwait() also sets the timer that gives up, so this never
            // becomes a stuck banner.
            armWakeAwait(text)
            if (!awaiting) playChime()
            setWakeStatus("Emet is listening — finish the command…")
            return
          }

          // No wake word — bare commands still obey: "next verse please",
          // "komeza", "verse 12", "clear the screen", "dusome Yohana 3:16".
          // Control/goto act on committed utterances (the whole utterance IS
          // the command); announced readings act on interims too, for speed.
          const bare = detectBareCommand(text)
          // Already a complete command? Then stop waiting for more words. The
          // silence window exists to reassemble sentences the recogniser cut
          // in half; "next verse" is not a half sentence, and making the
          // projector sit through 1.6s to confirm it felt a beat behind the
          // preacher every single time.
          if (!isFinal && bare && bare.intent !== "scripture") {
            utteranceRef.current?.expectCommand(FAST_COMMAND_MS)
          }
          if (bare && (isFinal || bare.intent === "scripture")) {
            const handled = handleWakeCommand(bare, isFinal)
            if (isFinal && bare.intent !== "scripture") lastFinalRef.current = ""
            if (handled) return
          }

          // Wake-free. With the Emet button on, the name never has to be
          // spoken: anything that reads as an instruction goes to the agent.
          //
          // looksLikeInstruction() is what keeps this safe — it demands that
          // the sentence name something the software owns, or be an explicit
          // ask. Congregational imperatives ("please turn with me in your
          // bibles", "somebody give the Lord a shout") name nothing of ours
          // and are left alone. Measured on 40 sentences of real preaching:
          // zero misfires, 13 of 13 real commands caught.
          // …and the ear's own judgement joins it. The patterns above are
          // English and French grammar written by hand; Kinyarwanda is
          // agglutinative and the ear mis-hears, so no list of verbs will ever
          // cover it. A real service proved that: "Muduhe icyo cyanditswe" was
          // transcribed perfectly and matched nothing. The model that just
          // understood the audio knows it was a request - in any language,
          // for no extra call. The two are a union, so this can only add.
          const heardAsRequest = lastRequestRef.current
          lastRequestRef.current = false
          if (
            isFinal && askEnabled && voice.agent &&
            (looksLikeInstruction(text) || heardAsRequest)
          ) {
            const now = Date.now()
            const sameAsLast = lastAgentAsk.current.text === text.trim()
            const tooSoon = now - lastAgentAsk.current.at < AGENT_MIN_GAP_MS
            if (!sameAsLast && !tooSoon) {
              lastAgentAsk.current = { text: text.trim(), at: now }
              lastFinalRef.current = ""
              void askAgent(text)
              return
            }
          }
        }

        const ref = detectReference(context)

        void (async () => {
          let verse: Verse | null = null
          let heard = ""

          // Map a verse found in a quote Bible (the ear's language) onto
          // the primary version shown on the wall.
          async function quoteToPrimary(qv: Verse, quoteId: string): Promise<Verse> {
            try {
              if (primaryOnline) {
                const tradition =
                  VERSIONS.find((x) => x.id === versionIds[0])?.tradition ?? "kjv"
                const frenchRules = overrides["ls1910"] ?? overrides["by"]
                const r = resolveParallelRef(qv, quoteId, tradition, frenchRules, mappings, overrides)
                const v = await primaryOnline.getVerse(r.bookNr, qv.book, r.chapter, r.verse)
                if (v) return v
              } else if (bible) {
                if (bible.meta.id === quoteId) return qv
                const v = resolveParallel(qv, quoteId, bible, mappings, overrides)
                if (v) return v
              }
            } catch {
              /* fall through to the quote Bible's own text */
            }
            return qv // honest fallback: right verse, quote Bible's version
          }

          // Is the preacher RECITING a verse — in their own words, without
          // naming it?
          //
          // Only finished sentences are considered. A growing interim looks
          // like a different verse every few words, and matching on it made
          // the screen flicker through wrong verses mid-sentence.
          let quote: {
            verse: Verse
            score: number
            margin: number
            confident: boolean
            sourceId: string
          } | null = null
          if (isFinal && !tooPoorToSearch(text)) {
            for (const qb of quoteBibles) {
              // The current sentence only. Joining it to the previous one
              // invents word combinations that were never actually spoken.
              const m = matchQuote(qb, text)
              if (m && (!quote || m.score > quote.score)) {
                quote = { ...m, sourceId: qb.meta.id }
              }
            }
          }

          if (quote && (!ref || quote.score >= QUOTE_OVERRIDES_REF)) {
            verse = await quoteToPrimary(quote.verse, quote.sourceId)
            heard = `“${text.trim().slice(0, 60)}…”`
          } else if (ref) {
            heard = ref.heard
            verse = await resolveHeardRef(ref)
          }

          if (!verse) return
          // Don't re-detect the verse already on the wall (preacher reading it aloud).
          if (nowShowing && refOf(nowShowing) === refOf(verse)) return

          const key = `${verse.bookNr}:${verse.chapter}:${verse.verse}`
          const now = Date.now()
          const spoken = lastLangRef.current

          // —— The interpreter confirms the preacher ——
          // In an interpreted service every verse is said twice: once in
          // Kinyarwanda, once in English. The second hearing is NOT a duplicate
          // to be swallowed — it is the same verse arriving through a different
          // language, from a different voice, matched against a different
          // Bible. That is the strongest evidence available in a noisy hall,
          // and it is exactly what a service with an interpreter provides for
          // free. A verse the preacher's accent left uncertain becomes certain
          // the moment the interpreter repeats it.
          const prior = detections.find((d) => d.key === key)
          const crossLanguage =
            !!prior &&
            !!spoken &&
            !!prior.lang &&
            prior.lang !== spoken &&
            now - prior.at < CONFIRM_WINDOW_MS

          if (crossLanguage) {
            setDetections((d) =>
              d.map((x) => (x.key === key ? { ...x, at: now, confirmed: true } : x))
            )
            recordLine(heard, "detected", `${refOf(verse)} (confirmed)`, 1)
            if (!autoMode) {
              setStaged(verse)
              setWakeStatus(
                `${refOf(verse)} — heard in both languages, this one is certain. ` +
                  "Press Ctrl+Enter to show it"
              )
            }
            return
          }

          if (lastProjectedRef.current.key === key && now - lastProjectedRef.current.at < 8000) return

          setDetections((d) =>
            d[0]?.key === key
              ? d
              : [{ key, heard, verse, at: Date.now(), score: quote?.score, lang: spoken },
                 ...d].slice(0, 8)
          )
          recordLine(heard, "detected", refOf(verse), quote?.score ?? 0)
          if (quote?.confident) track("quote_matched")

          // Whether it goes on the wall is the OPERATOR'S choice, not ours.
          // Suggest means suggest: detections wait in Preview, one keypress
          // away. Overriding that turned every uncertain guess into a change
          // on the screen in front of the congregation.
          if (!autoMode) {
            setStaged(verse)
            if (quote) {
              setWakeStatus(
                `Sounds like ${refOf(verse)} — press Ctrl+Enter to show it` +
                  (quote.confident ? "" : " (not certain)")
              )
            }
            return
          }

          // Automatic mode. Even here, only act on a match we are sure of, and
          // never replace what is on screen more than once every few seconds —
          // a projector that changes constantly is worse than a slow one.
          if (quote && !quote.confident) {
            setStaged(verse)
            setWakeStatus(`Sounds like ${refOf(verse)} — not certain, waiting in Preview`)
            return
          }
          if (now - lastProjectedRef.current.at < PROJECT_COOLDOWN_MS) {
            setStaged(verse)
            return
          }
          lastProjectedRef.current = { key, at: now }
          lastLive.current = verse
          onProject(verse)
          track("verse_shown")
          if (quote) setWakeStatus(`Heard you quoting ${refOf(verse)} — on the screen`)
        })()
  }

  // Start/stop the ear. This depends ONLY on whether we should be listening
  // and in which language — nothing else. Every other value the handler needs
  // is read live through onTranscriptRef, so projecting a verse (or any other
  // state change) can never interrupt the microphone mid-sentence.
  useEffect(() => {
    if (!listening) return
    track("ear_start")

    // Open the service record. Everything heard from here until the microphone
    // closes is filed under this id, ready to be reviewed — and corrected —
    // afterwards. If the write fails the ear carries on regardless; recording
    // is for improving EmetAI, never a condition of it working.
    seqRef.current = 0
    void api
      .startService({
        title: new Date().toLocaleString(undefined, {
          weekday: "long",
          hour: "2-digit",
          minute: "2-digit",
        }),
        ear: earLang,
      })
      .then((s) => {
        serviceRef.current = s.id
      })
      .catch(() => {
        serviceRef.current = ""
      })

    // Neither ear hands us sentences — Chrome commits a "final" whenever its
    // own segmenter decides to, which cuts people mid-thought. The assembler
    // reassembles the pieces and only calls a sentence finished once the room
    // has actually gone quiet, so "what are three main" + "quotes of Jesus
    // Christ" reach Emet as the one question that was asked.
    // The local ear's server has already waited out a pause (ear.SILENCE_SECS)
    // before it sends a final, so the browser waiting the full window again
    // simply doubled the delay. Chrome's recogniser does no such thing, and
    // still needs the long window to have its cut sentences put back together.
    const utterance = new UtteranceAssembler(
      {
        onPartial: (text) => onTranscriptRef.current(text, false),
        onSettled: (text) => onTranscriptRef.current(text, true),
      },
      earLang === "gemini-auto"
        ? REMOTE_EAR_SETTLE_MS
        : earLang.startsWith("local-")
          ? LOCAL_EAR_SETTLE_MS
          : SILENCE_MS
    )
    utteranceRef.current = utterance

    const callbacks = {
      onTranscript: (
        text: string,
        isFinal: boolean,
        lang?: string,
        role?: string,
        isRequest?: boolean
      ) => {
        // Remember the language and the speaker before the assembler settles
        // the sentence — by the time onSettled fires the socket message is
        // long gone, and both are needed to attribute the line.
        if (lang) lastLangRef.current = lang
        if (role) lastRoleRef.current = role
        if (isRequest) lastRequestRef.current = true
        utterance.push(text, isFinal)
      },
      onError: (message: string) => {
        setMicError(message)
        setListening(false)
      },
      onStatus: (message: string) => setInterimLine(message),
      onLevel: (level: number) =>
        // Only re-render when the room's loudness actually changes; otherwise
        // silence would repaint the whole Studio twenty times a second.
        setMicLevel((prev) => (Math.abs(prev - level) > 0.05 ? level : prev)),
    }

    if (earLang.startsWith("local-") || earLang === "gemini-auto") {
      const ear = new LocalEar()
      earRef.current = ear
      // "gemini-auto" reaches the server as lang=auto, which is the key into
      // ear.CONFIG that selects Gemini instead of a local Whisper model.
      void ear.start(
        (earLang === "gemini-auto" ? "auto" : earLang.replace("local-", "")) as
          "en" | "fr" | "rw" | "auto",
        callbacks,
        audioSource
      )

      // The trigger lane. Only for the remote ear: the offline ears already
      // produce interims of their own, and running two recognisers over one
      // microphone is a cost worth paying only where it buys three seconds.
      let fast: SpeechListener | null = null
      if (earLang === "gemini-auto" && audioSource === "microphone") {
        try {
          fast = new SpeechListener()
          fast.start(FAST_LANE_LANG, {
            onTranscript: (text) => onFastHintRef.current(text),
            // Silent on purpose. If the browser refuses a second recogniser,
            // or this machine has none, the Gemini ear carries on exactly as
            // before - slower, but working. A convenience must never be able
            // to take the ear down with it.
            onError: () => {},
          })
        } catch {
          fast = null
        }
      }

      return () => {
        earRef.current = null
        utteranceRef.current = null
        utterance.reset()
        setMicLevel(0)
        ear.stop()
        fast?.stop()
        gate.current.reset()
        closeService()
      }
    }
    // The browser's recogniser opens its OWN microphone and cannot be given a
    // different stream, so "from this computer" is impossible on these ears.
    // Say so rather than listening to the room and appearing simply deaf.
    if (audioSource === "computer") {
      setMicError(
        "To listen to this computer, choose “Ear: Auto · RW + EN + FR”. " +
          "The browser ears can only use the microphone."
      )
      setListening(false)
      return
    }

    // The browser's recogniser keeps its microphone to itself, so the orb
    // follows the flow of speech instead of its loudness.
    const listener = new SpeechListener()
    listener.start(earLang, callbacks)
    return () => {
      utteranceRef.current = null
      utterance.reset()
      setMicLevel(0)
      listener.stop()
      gate.current.reset()
      closeService()
    }
  }, [listening, earLang, audioSource])

  // Online primary: fetch the referenced verse (debounced).
  useEffect(() => {
    if (!primaryOnline) return
    const q = query.trim()
    const ref = q ? parseReference(q) : null
    if (!ref) return
    let cancelled = false
    const timer = setTimeout(async () => {
      let verses: Verse[]
      try {
        const verse = await primaryOnline.getVerse(ref.bookNr, ref.book, ref.chapter, ref.verse ?? 1)
        verses = verse ? [verse] : []
      } catch {
        verses = []
      }
      if (!cancelled) setOnlineHit({ q, verses })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, primaryOnline])

  // Load the quote Bibles for the ear's language and warm their indexes, so
  // recited verses are recognized the moment listening starts.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const loaded: Bible[] = []
      for (const id of QUOTE_BIBLES_FOR_EAR[earLang]) {
        if (bible && bible.meta.id === id) {
          loaded.push(bible)
          continue
        }
        const version = VERSIONS.find((v) => v.id === id)
        if (!version || version.source !== "local") continue
        try {
          loaded.push(await loadBible(version))
        } catch {
          /* quote matching just skips this translation */
        }
      }
      if (!cancelled) {
        setQuoteBibles(loaded)
        for (const b of loaded) warmQuoteIndex(b)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [earLang, bible])

  async function goNext() {
    if (!nowShowing) return
    if (primaryOnline) {
      try {
        let n = await primaryOnline.getVerse(nowShowing.bookNr, nowShowing.book, nowShowing.chapter, nowShowing.verse + 1)
        if (!n) n = await primaryOnline.getVerse(nowShowing.bookNr, nowShowing.book, nowShowing.chapter + 1, 1)
        if (n) goLive(n)
      } catch {
        /* stay put */
      }
      return
    }
    if (!bible) return
    const n = nextVerse(bible, nowShowing)
    if (n) goLive(n)
  }

  async function goPrev() {
    if (!nowShowing) return
    if (primaryOnline) {
      if (nowShowing.verse <= 1) return
      try {
        const p = await primaryOnline.getVerse(nowShowing.bookNr, nowShowing.book, nowShowing.chapter, nowShowing.verse - 1)
        if (p) goLive(p)
      } catch {
        /* stay put */
      }
      return
    }
    if (!bible) return
    const p = prevVerse(bible, nowShowing)
    if (p) goLive(p)
  }

  const canPrev = !!nowShowing && (isOnline ? nowShowing.verse > 1 : !!bible && !!prevVerse(bible, nowShowing))
  const canNext = !!nowShowing && (isOnline ? true : !!bible && !!nextVerse(bible, nowShowing))

  // Manual ask: "?elohim" or "ask mao zedong" in the search box.
  const isAsk = /^\?|^ask\s/i.test(trimmed)

  function manualAsk(live: boolean) {
    const raw = trimmed.replace(/^\?/, "").replace(/^ask\s+/i, "").trim()
    if (!raw) return
    if (!askEnabled) {
      setWakeStatus("AI answers are part of the Pro plan — open Account to upgrade.")
      setQuery("")
      return
    }
    // Allow "hebrew:" / "greek:" prefixes for word studies.
    const m = raw.match(/^(hebrew|greek)[:\s]+(.+)$/i)
    const scope = (m ? m[1].toLowerCase() : "") as "hebrew" | "greek" | ""
    const q = m ? m[2] : raw
    setQuery("")
    void askBrain(q, "auto", scope, live)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && isAsk) {
      e.preventDefault()
      manualAsk(e.ctrlKey) // Enter stages the answer, Ctrl+Enter sends it live
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, results.length - 1))
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    }
    if (e.key === "Enter") {
      if (e.ctrlKey) {
        if (staged) goLive(staged)
        else if (stagedCard) {
          onProjectCard(stagedCard)
          setStagedCard(null)
        }
      } else if (e.shiftKey && results[selected]) {
        enqueue(results[selected]) // build the service queue without leaving the box
        setQuery("")
      } else if (results[selected]) {
        stage(results[selected])
        setQuery("")
      } else if (query === "" && staged) {
        goLive(staged)
      } else if (query === "" && stagedCard) {
        onProjectCard(stagedCard)
        setStagedCard(null)
      }
    }
    if (e.key === "Escape") {
      if (query) setQuery("")
      else {
        setStaged(null)
        setStagedCard(null)
      }
    }
    if (query === "") {
      if (e.key === "ArrowRight") {
        e.preventDefault()
        goNext()
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault()
        goPrev()
      }
    }
  }

  return (
    <main className="flex h-full flex-col bg-ink-soft text-parchment">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-parchment/10 px-4 py-2.5">
        <p className="font-sans text-xs uppercase tracking-[0.3em] text-parchment-dim/50">
          Live service
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((slot) => (
              <select
                key={slot}
                value={versionIds[slot] ?? "none"}
                onChange={(e) => {
                  const ids = [...versionIds]
                  if (e.target.value === "none") ids.splice(slot, 1)
                  else ids[slot] = e.target.value
                  onChangeVersions(ids)
                }}
                className={`rounded-md border bg-ink px-2 py-1.5 font-sans text-sm outline-none transition focus:border-gold/60 ${
                  slot === 0 ? "border-gold/40 text-parchment" : "border-parchment/15 text-parchment-dim"
                }`}
              >
                {slot > 0 && <option value="none">{slot === 1 ? "+ 2nd" : "+ 3rd"}</option>}
                {localVersions.map((v) => (
                  <option key={v.id} value={v.id}>{v.short}</option>
                ))}
                {onlineVersions.map((v) => (
                  <option key={v.id} value={v.id}>{v.short} (online)</option>
                ))}
              </select>
            ))}
            <button
              onClick={onToggleShowPrimary}
              className={`rounded-md border px-2.5 py-1.5 font-sans text-sm transition ${
                showPrimary ? "border-gold/40 text-gold" : "border-parchment/15 text-parchment-dim/60"
              }`}
            >
              {showPrimary ? "1st: shown" : "1st: hidden"}
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Where the sound comes from. A service playing on THIS laptop
                cannot be heard through the microphone — the browser's echo
                cancellation removes sound the computer itself is making. */}
            <select
              value={audioSource}
              onChange={(e) => setAudioSource(e.target.value as AudioSource)}
              disabled={listening}
              title={
                audioSource === "computer"
                  ? "Listening to what this computer is playing"
                  : "Listening to the room through the microphone"
              }
              className="rounded-md border border-parchment/15 bg-ink px-2 py-1.5 font-sans text-sm text-parchment-dim outline-none disabled:opacity-50"
            >
              <option value="microphone">🎤 From the room</option>
              <option value="computer">💻 From this computer</option>
            </select>
            <select
              value={earLang}
              onChange={(e) => setEarLang(e.target.value as EarLang)}
              disabled={listening}
              className="rounded-md border border-parchment/15 bg-ink px-2 py-1.5 font-sans text-sm text-parchment-dim outline-none disabled:opacity-50"
            >
              <option value="gemini-auto">Ear: Auto · RW + EN + FR</option>
              <option value="en-US">Ear: EN (browser)</option>
              <option value="fr-FR">Ear: FR (browser)</option>
              <option value="local-en">Ear: EN (local, offline)</option>
              <option value="local-fr">Ear: FR (local, offline)</option>
              <option value="local-rw">Ear: RW (local, offline) 🇷🇼</option>
            </select>
            <button
              onClick={() => setWakeEnabled((w) => !w)}
              title='Voice commands: "Emet, John 4:5" · "Emet, definition of Elohim" · and bare "next verse", "verse 12", "clear the screen", "dusome Yohana 3:16" — hands-free'
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-sans text-sm transition ${
                wakeEnabled
                  ? "border-gold/40 text-gold"
                  : listening
                    // The microphone is open but every spoken command is being
                    // ignored. That must not look like an ordinary dim button —
                    // it is the single most confusing state in the studio.
                    ? "border-rose-400/60 bg-rose-500/10 text-rose-200"
                    : "border-parchment/15 text-parchment-dim"
              }`}
            >
              <ListeningOrb
                state={wakeEnabled ? orbState : "idle"}
                level={micLevel}
                size={16}
              />
              {wakeEnabled ? "Emet" : listening ? "Emet off" : "Emet"}
            </button>
            {/* Emet's own voice. Off by default — a laptop that starts talking
                mid-service is worse than a quiet one — but one click away. */}
            {voiceOutputSupported() && (
              <select
                value={voiceGender}
                onChange={(e) => {
                  const next = e.target.value as VoiceGender
                  setVoiceGender(next)
                  saveVoicePreference(next)
                  stopSpeaking()
                  if (next !== "off") say("Emet is ready", earLang, next)
                }}
                title="Should Emet answer out loud, and in whose voice?"
                className={`rounded-md border bg-ink px-2 py-1.5 font-sans text-sm outline-none transition ${
                  voiceGender === "off"
                    ? "border-parchment/15 text-parchment-dim"
                    : "border-gold/40 text-gold"
                }`}
              >
                <option value="off">🔇 Voice off</option>
                <option value="female">🔊 Voice · female</option>
                <option value="male">🔊 Voice · male</option>
              </select>
            )}
            <button
              onClick={() => setAutoMode((a) => !a)}
              title={
                autoMode
                  ? "Automatic: verses EmetAI is sure of go straight to the projector"
                  : "Suggest: everything EmetAI hears waits in Preview until you press Ctrl+Enter"
              }
              className={`rounded-md border px-2.5 py-1.5 font-sans text-sm transition ${
                autoMode ? "border-gold/40 text-gold" : "border-parchment/15 text-parchment-dim"
              }`}
            >
              {autoMode ? "Auto" : "Suggest"}
            </button>
            <button
              onClick={() => {
                // The administrator's switch comes first: below it the whole
                // voice pipeline is dormant, whatever plan the church is on.
                if (voice.loaded && !voice.enabled) {
                  setMicError(
                    "The voice assistant is switched off for this installation. An " +
                      "administrator can turn it on in Admin → Settings → Voice assistant."
                  )
                  return
                }
                if (!aiEnabled) {
                  setMicError(
                    "AI listening is part of the Pro plan — open Account to upgrade. " +
                      "Manual search and projection stay free for ever."
                  )
                  return
                }
                setMicError(null)
                setListening((l) => !l)
              }}
              title={
                voice.loaded && !voice.enabled
                  ? "Switched off by the administrator"
                  : aiEnabled
                    ? "Listen to the preacher"
                    : "Pro plan feature"
              }
              className={`rounded-md border px-3 py-1.5 font-sans text-sm transition ${
                listening
                  ? "border-gold bg-gold/15 text-gold"
                  : aiEnabled && voice.enabled
                    ? "border-parchment/20 text-parchment-dim hover:border-gold/60 hover:text-gold"
                    : "border-parchment/15 text-parchment-dim/40"
              }`}
            >
              {listening
                ? "● Listening"
                : voice.loaded && !voice.enabled
                  ? "⏻ Voice off"
                  : aiEnabled
                    ? "🎤 Listen"
                    : "🔒 Listen"}
            </button>
          </div>

          <button
            onClick={() => {
              lastLive.current = nowShowing ?? lastLive.current
              onProjectCard(null) // clear an answer as well as a verse
              onProject(null)
            }}
            className="rounded-md border border-parchment/20 px-3 py-1.5 font-sans text-sm text-parchment-dim transition hover:border-gold/60 hover:text-gold"
          >
            Blank
          </button>
          <button
            onClick={() => {
              track("display_opened")
              window.open("#display", "emetai-display")
            }}
            className="rounded-md bg-gold px-3 py-1.5 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep"
          >
            Open display →
          </button>
        </div>
      </header>

      {/* Cockpit grid */}
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-3 p-3">
        {/* Left: live transcript */}
        <section className="col-span-3 flex min-h-0 flex-col rounded-xl border border-parchment/10 bg-ink p-3">
          <p className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
            Live transcript
          </p>
          <div className="mt-2">
            <ListeningBanner
              state={orbState}
              level={micLevel}
              title={
                orbState === "thinking"
                  ? "Emet is thinking…"
                  : orbState === "hearing"
                    ? "Listening — I can hear you"
                    : orbState === "listening"
                      ? "Listening…"
                      : "Not listening"
              }
              detail={
                orbState === "idle"
                  ? "Press Listen to open the microphone"
                  : wakeEnabled
                    ? "Say “Emet …”, or just speak — I follow the scripture"
                    : "Voice commands are OFF — press the Emet button to turn them back on"
              }
            />
            {listening && !wakeEnabled && (
              <button
                onClick={() => setWakeEnabled(true)}
                className="mt-2 w-full rounded-lg border border-rose-400/50 bg-rose-500/10 px-3 py-2 text-left font-sans text-xs text-rose-200 transition hover:border-rose-300"
              >
                <span className="font-medium">Emet is not taking commands.</span> I am
                still hearing the room, but “Emet, John 4:5”, “next verse” and “clear the
                screen” will all be ignored. Tap to switch voice commands back on.
              </button>
            )}
          </div>
          <div className="mt-2 flex-1 space-y-2 overflow-y-auto font-sans text-sm text-parchment-dim">
            {!askEnabled && (
              <div className="rounded-lg border border-gold/25 bg-gold/5 p-3">
                <p className="font-sans text-xs font-medium text-gold">
                  Your plan: {user?.tierLabel ?? "Free"} — the AI ear is included
                </p>
                <p className="mt-1.5 font-sans text-xs leading-relaxed text-parchment-dim">
                  Listening and “Emet, John 3:16” are yours at no cost, for ever. Pro adds AI
                  answers — say “Emet, the Hebrew definition of Elohim” and the explanation
                  appears on the projector.
                </p>
                <a
                  href="#/account"
                  className="mt-2 inline-block rounded-md bg-gold px-3 py-1.5 font-sans text-xs font-medium text-ink transition hover:bg-gold-deep"
                >
                  See the plans →
                </a>
              </div>
            )}
            {transcript.length === 0 && !interimLine && (
              <p className="text-parchment-dim/40">
                {listening ? "Listening…" : "Click 🎤 Listen to start transcribing."}
              </p>
            )}
            {/* Every line can be corrected, and a correction teaches the ear.
                This is the only place in EmetAI where a mistake turns into an
                improvement, so it has to be one click away — an operator mid
                service will not open a settings page to report a mishearing. */}
            {transcript.map((line, i) =>
              fixing?.index === i ? (
                <form
                  key={i}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void teach(line.text, fixing.text)
                  }}
                  className="rounded-lg border border-gold/40 bg-gold/5 p-2"
                >
                  <label className="font-sans text-[11px] uppercase tracking-wider text-gold/80">
                    What was actually said?
                  </label>
                  <input
                    autoFocus
                    value={fixing.text}
                    onChange={(e) => setFixing({ index: i, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setFixing(null)
                      e.stopPropagation()
                    }}
                    className="mt-1 w-full rounded-md border border-parchment/20 bg-ink px-2 py-1.5 font-sans text-sm text-parchment outline-none focus:border-gold"
                  />
                  <div className="mt-1.5 flex gap-2">
                    <button
                      type="submit"
                      className="rounded-md bg-gold px-2.5 py-1 font-sans text-[11px] font-medium text-ink transition hover:bg-gold-deep"
                    >
                      Teach Emet
                    </button>
                    <button
                      type="button"
                      onClick={() => setFixing(null)}
                      className="rounded-md border border-parchment/20 px-2.5 py-1 font-sans text-[11px] text-parchment-dim transition hover:border-parchment/40"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <p key={i} className="group flex items-start gap-2">
                  {line.role && (
                    <span
                      title={
                        line.role === "both"
                          ? "Two people spoke at once — Emet will not guess which"
                          : `Emet attributes this to the ${line.role}`
                      }
                      className={`mt-0.5 shrink-0 rounded px-1.5 py-px font-sans text-[10px] uppercase tracking-wider ${
                        line.role === "preacher"
                          ? "bg-gold/15 text-gold"
                          : line.role === "interpreter"
                            ? "bg-sky-400/15 text-sky-300"
                            : line.role === "both"
                              ? "bg-rose-400/15 text-rose-300"
                              : "bg-parchment/10 text-parchment-dim/70"
                      }`}
                    >
                      {line.role}
                    </span>
                  )}
                  <span className="flex-1">{line.text}</span>
                  <button
                    onClick={() => setFixing({ index: i, text: line.text })}
                    title="Emet misheard this — teach it the right words"
                    className="mt-0.5 shrink-0 rounded px-1 font-sans text-[11px] text-parchment-dim/0 transition group-hover:text-gold/70 hover:!text-gold"
                  >
                    ✎ fix
                  </button>
                </p>
              )
            )}
            {interimLine && <p className="text-parchment/80">{interimLine} ●</p>}
          </div>
          {learned && (
            <p className="mt-2 rounded-md border border-gold/30 bg-gold/10 px-2 py-1.5 font-sans text-xs text-gold">
              {learned} — Emet will hear that correctly from now on.
            </p>
          )}
          {micError && <p className="mt-2 font-sans text-xs text-red-400/80">{micError}</p>}
          {!speechSupported() && (
            <p className="mt-2 font-sans text-xs text-parchment-dim/50">Needs Chrome or Edge.</p>
          )}
        </section>

        {/* Center: preview + live, search, chapter browser */}
        <section className="col-span-6 flex min-h-0 flex-col gap-3">
          <div className="flex gap-3">
            {stagedCard ? (
              <MiniBrainCard title="Preview · answer" card={stagedCard} />
            ) : (
              <MiniVerseCard title="Preview" verse={staged} />
            )}
            {liveCard ? (
              <MiniBrainCard title="Live display · answer" card={liveCard} live />
            ) : (
              <MiniVerseCard title="Live display" verse={nowShowing} live />
            )}
          </div>
          {(wakeStatus || asking) && (
            <p className="flex items-start gap-2.5 rounded-lg border border-gold/25 bg-gold/5 px-3 py-2 font-sans text-xs leading-relaxed text-gold/90">
              <ListeningOrb state={asking ? "thinking" : orbState} level={micLevel} size={18} />
              <span className="pt-0.5">
                {asking ? (wakeStatus ?? "Emet is thinking…") : wakeStatus}
              </span>
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (staged) goLive(staged)
                else if (stagedCard) {
                  onProjectCard(stagedCard)
                  setStagedCard(null)
                }
              }}
              disabled={!staged && !stagedCard}
              className="rounded-md bg-gold px-4 py-2 font-sans text-sm font-medium text-ink transition hover:bg-gold-deep disabled:opacity-30"
            >
              Go live → (Ctrl+Enter)
            </button>
            <button
              onClick={goPrev}
              disabled={!canPrev}
              className="rounded-md border border-parchment/20 px-3 py-2 font-sans text-sm text-parchment-dim transition enabled:hover:border-gold/60 enabled:hover:text-gold disabled:opacity-30"
            >
              ← Prev
            </button>
            <button
              onClick={goNext}
              disabled={!canNext}
              className="rounded-md border border-parchment/20 px-3 py-2 font-sans text-sm text-parchment-dim transition enabled:hover:border-gold/60 enabled:hover:text-gold disabled:opacity-30"
            >
              Next →
            </button>
            <p className="ml-auto truncate font-sans text-xs text-parchment-dim/50">
              {primaryLabel}
              {isOnline ? " · online" : ""}
              {!showPrimary ? " · primary hidden" : ""}
            </p>
          </div>

          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={
              isOnline
                ? "Reference (john 3:16)" +
                  (askEnabled ? " · ?word asks Emet (?elohim, ?mao zedong)" : "") +
                  " — Enter stages, Ctrl+Enter live"
                : "Shakisha… (zab 23:1, yoh 3 16)" +
                  (askEnabled ? " · ?ijambo ribaza Emet (?elohim)" : "") +
                  " — Enter stages, Ctrl+Enter live"
            }
            className="w-full rounded-xl border border-parchment/15 bg-ink px-4 py-3 font-sans text-base text-parchment placeholder:text-parchment-dim/40 outline-none transition focus:border-gold/60"
          />

          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {results.map((v, i) => (
              <li key={refOf(v)} className="flex items-stretch gap-1.5">
                <button
                  onClick={() => {
                    stage(v)
                    setQuery("")
                  }}
                  onMouseEnter={() => setSelected(i)}
                  className={`min-w-0 flex-1 rounded-lg border px-4 py-2 text-left transition ${
                    i === selected ? "border-gold/70 bg-gold/10" : "border-transparent bg-ink hover:border-parchment/20"
                  }`}
                >
                  <span className="font-sans text-sm font-medium text-sky">{refOf(v)}</span>
                  <p className="mt-0.5 line-clamp-2 font-display text-sm text-parchment/90">{v.text}</p>
                </button>
                <button
                  onClick={() => enqueue(v)}
                  title="Add to queue (Shift+Enter)"
                  className="rounded-lg border border-parchment/15 px-2.5 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                >
                  + Queue
                </button>
              </li>
            ))}
            {searching && <li className="px-4 py-2 font-sans text-sm text-parchment-dim/60">Searching…</li>}
            {trimmed && !searching && results.length === 0 && (
              <li className="px-4 py-2 font-sans text-sm text-parchment-dim/60">
                {isOnline
                  ? parsedRef === null
                    ? "Keep typing the reference — add a chapter (e.g. john 3)."
                    : "That verse was not found in this version."
                  : "Nta murongo ubonetse — try a book name or a word from the verse."}
              </li>
            )}
            {!trimmed &&
              chapterVerses.map((v) => (
                <li key={refOf(v)} className="flex items-stretch gap-1.5">
                  <button
                    onClick={() => stage(v)}
                    className={`min-w-0 flex-1 rounded-lg border px-4 py-1.5 text-left transition ${
                      nowShowing && refOf(nowShowing) === refOf(v)
                        ? "border-gold/50 bg-gold/10"
                        : "border-transparent bg-ink hover:border-parchment/20"
                    }`}
                  >
                    <span className="font-sans text-xs font-medium text-sky">{v.verse}</span>
                    <span className="ml-2 font-display text-sm text-parchment/85">
                      {v.text.length > 110 ? v.text.slice(0, 110) + "…" : v.text}
                    </span>
                  </button>
                  <button
                    onClick={() => enqueue(v)}
                    title="Add to queue"
                    className="rounded-lg border border-parchment/15 px-2 font-sans text-xs text-parchment-dim transition hover:border-gold/60 hover:text-gold"
                  >
                    +
                  </button>
                </li>
              ))}
          </ul>
          <p className="font-sans text-xs text-parchment-dim/50">
            Enter: stage · Shift+Enter: queue · Ctrl+Enter: go live · Esc: clear · ←→ walk chapter · ?query asks Emet
            {wakeEnabled && listening
              ? " · 🎙 “Emet, …” or just “next verse” / “verse 12” / “clear the screen”"
              : ""}
          </p>
        </section>

        {/* Right: queue + detections */}
        <section className="col-span-3 flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-parchment/10 bg-ink p-3">
            <div className="flex items-center justify-between">
              <p className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
                Queue {queue.length > 0 && `· ${queue.length}`}
              </p>
              {queue.length > 0 && (
                <button
                  onClick={() => setQueue([])}
                  className="font-sans text-xs text-parchment-dim/50 hover:text-gold"
                >
                  ✕ Clear
                </button>
              )}
            </div>
            <ul className="mt-2 flex-1 space-y-1.5 overflow-y-auto">
              {queue.length === 0 && (
                <p className="font-sans text-sm text-parchment-dim/40">
                  Prepare verses here before the service.
                </p>
              )}
              {queue.map((v) => (
                <li key={refOf(v)} className="flex items-center gap-1.5">
                  <button
                    onClick={() => stage(v)}
                    className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-ink-soft px-2.5 py-1.5 text-left font-sans text-sm text-parchment hover:border-parchment/20"
                  >
                    {refOf(v)}
                  </button>
                  <button
                    onClick={() => goLive(v)}
                    title="Present now"
                    className="rounded-md border border-parchment/15 px-2 py-1.5 font-sans text-xs text-gold hover:border-gold/60"
                  >
                    ▶
                  </button>
                  <button
                    onClick={() => setQueue((q) => q.filter((x) => refOf(x) !== refOf(v)))}
                    className="rounded-md border border-parchment/15 px-2 py-1.5 font-sans text-xs text-parchment-dim hover:border-gold/60 hover:text-gold"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-parchment/10 bg-ink p-3">
            <div className="flex items-center justify-between">
              <p className="font-sans text-xs uppercase tracking-[0.25em] text-parchment-dim/60">
                Recent detections
              </p>
              {detections.length > 0 && (
                <button
                  onClick={() => setDetections([])}
                  className="font-sans text-xs text-parchment-dim/50 hover:text-gold"
                >
                  ✕ Clear
                </button>
              )}
            </div>
            <ul className="mt-2 flex-1 space-y-2 overflow-y-auto">
              {detections.length === 0 && (
                <p className="font-sans text-sm text-parchment-dim/40">
                  Heard references appear here.
                </p>
              )}
              {detections.map((d) => (
                <li key={d.key + d.at} className="rounded-lg bg-ink-soft p-2.5">
                  <p className="flex items-center justify-between font-sans text-sm font-medium text-sky">
                    <span>
                      <span className="mr-1.5 text-gold">●</span>
                      {refOf(d.verse)}
                    </span>
                    {d.confirmed && (
                      <span
                        title="Heard in Kinyarwanda and in English — the interpreter said the same verse"
                        className="mr-1 rounded bg-mint/20 px-1.5 py-0.5 font-sans text-[0.6rem] text-mint"
                      >
                        ✓ both languages
                      </span>
                    )}
                    {d.score !== undefined && (
                      <span
                        className={`rounded px-1.5 py-0.5 font-sans text-[0.6rem] ${
                          d.confirmed || d.score >= CONFIDENT
                            ? "bg-mint/15 text-mint"
                            : "bg-parchment/10 text-parchment-dim/70"
                        }`}
                        title="How closely what was said matches this verse"
                      >
                        {Math.round(Math.min(1, d.score) * 100)}%
                      </span>
                    )}
                  </p>
                  {d.heard && (
                    <p className="mt-0.5 truncate font-sans text-[0.65rem] text-parchment-dim/50">
                      heard: {d.heard}
                    </p>
                  )}
                  <p className="mt-1 line-clamp-2 font-display text-xs text-parchment/80">{d.verse.text}</p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      onClick={() => goLive(d.verse)}
                      className="rounded bg-gold px-2 py-1 font-sans text-xs font-medium text-ink hover:bg-gold-deep"
                    >
                      ▶ Present
                    </button>
                    <button
                      onClick={() => enqueue(d.verse)}
                      className="rounded border border-parchment/15 px-2 py-1 font-sans text-xs text-parchment-dim hover:border-gold/60 hover:text-gold"
                    >
                      + Queue
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  )
}