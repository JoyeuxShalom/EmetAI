// The AI ear, Stage 1: browser speech recognition (Chrome/Edge) + reference detection.
// Stage 2 will add a Kinyarwanda ASR engine behind this same interface.

import { normalize } from "../data/bible"
import { CANONICAL_BOOKS } from "../data/books"
import { numberWordsToDigits } from "./spokenNumbers"

export type HeardReference = {
  bookNr: number
  book: string
  chapter: number
  verse: number | null
  heard: string
}

/** Levenshtein distance, capped at 2 for speed. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
  }
  return dp[a.length][b.length]
}

function findBook(word: string) {
  // 1) Exact / prefix match (as before).
  const exact = CANONICAL_BOOKS.find(
    (b) =>
      b.aliases.some((a) => a === word || (word.length >= 3 && a.startsWith(word))) ||
      normalize(b.name).replace(/\s+/g, "") === word
  )
  if (exact) return exact

  // 2) Conservative fuzzy fallback for ASR mishears ("romands", "collosians"):
  //    one edit away, both words at least 5 letters.
  if (word.length < 5) return null
  let best: { book: (typeof CANONICAL_BOOKS)[number]; d: number } | null = null
  for (const b of CANONICAL_BOOKS) {
    for (const a of b.aliases) {
      if (a.length < 5) continue
      const d = editDistance(word, a)
      if (d <= 1 && (!best || d < best.d)) best = { book: b, d }
    }
  }
  return best?.book ?? null
}

// Stems of the numbered books, for gluing a spoken ordinal onto the name
// ("1 samweli", "petero wa kabiri") without touching ordinary words.
const NUMBERED_BOOK_STEMS =
  "sam|samweli|samuel|kgs|kings|abami|rois|chr|ngoma|chronicles|chroniques|" +
  "cor|korinto|abakorinto|corinthians|corinthiens|thess|tesalonike|abatesalonike|" +
  "thessalonians|thessaloniciens|tim|timoteyo|timothy|timothee|pet|petero|peter|" +
  "pierre|jn|john|yohana|jean"

/** Find the most recent scripture reference mentioned in a transcript.
 *  Understands spoken numbers in Kinyarwanda, English and French. */
export function detectReference(transcript: string): HeardReference | null {
  let t = normalize(transcript)
  // English ordinal prefixes: "first john" -> "1john"
  t = t
    .replace(/\b(first)\s+(?=[a-z])/g, "1")
    .replace(/\b(second)\s+(?=[a-z])/g, "2")
    .replace(/\b(third)\s+(?=[a-z])/g, "3")
  // Kinyarwanda ordinal suffixes: "petero wa kabiri" -> "2petero"
  t = t
    .replace(new RegExp(`\\b(${NUMBERED_BOOK_STEMS})\\s+(?:wa|ya|cya|rya)\\s+mbere\\b`, "g"), "1$1")
    .replace(new RegExp(`\\b(${NUMBERED_BOOK_STEMS})\\s+(?:wa|ya|cya|rya)\\s+kabiri\\b`, "g"), "2$1")
    .replace(new RegExp(`\\b(${NUMBERED_BOOK_STEMS})\\s+(?:wa|ya|cya|rya)\\s+gatatu\\b`, "g"), "3$1")
  // Spoken numbers -> digits (rw/en/fr): "umurongo wa kabiri" -> "umurongo wa 2"
  t = numberWordsToDigits(t)
  // Chapter/verse words in all three languages (incl. common ASR mishears
  // like "versus" and the merged "murongwa").
  t = t.replace(
    /\b(chapter|chapters|verse|verses|versus|chapitre|chapitres|verset|versets|umutwe|imitwe|umurongo|imirongo|murongo|murongwa|umurongwa|igice|ibice|gice|igitabo|gitabo)\b/g,
    " "
  )
  // Small filler words between book and numbers: "mu gitabo cya yohana",
  // "du 1er verset", "igice CYA gatatu".
  t = t.replace(/\b(wa|ya|cya|rya|bya|za|uwa|ku|mu|du|de|le|la|les|et|au|aux|na|no|ni|n)\b/g, " ")
  // Chrome writes references as "John 6:65" — treat ":" as a separator.
  t = t.replace(/:/g, " ")
  t = t.replace(/\s+/g, " ").trim()
  // Glue a leading 1-3 onto numbered-book names only ("1 yohana" -> "1yohana").
  t = t.replace(new RegExp(`\\b([1-3])\\s+(?=(?:${NUMBERED_BOOK_STEMS})\\b)`, "g"), "$1")

  const re = /(\d?[a-z]+)\s+(\d{1,3})(?:\s+(\d{1,3}))?/g
  let best: HeardReference | null = null
  for (const m of Array.from(t.matchAll(re))) {
    const [phrase, word, chapterStr, verseStr] = m
    const book = findBook(word)
    if (!book) continue
    best = {
      bookNr: book.nr,
      book: book.name,
      chapter: parseInt(chapterStr),
      verse: verseStr ? parseInt(verseStr) : null,
      heard: phrase,
    }
  }
  return best
}

// ---- Browser speech recognition wrapper ----

type RecognitionCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (message: string) => void
  onStatus?: (message: string) => void
}

type SpeechRecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type SpeechRecognitionEventLike = {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>
  return (
    (w.SpeechRecognition as (new () => SpeechRecognitionLike) | undefined) ??
    (w.webkitSpeechRecognition as (new () => SpeechRecognitionLike) | undefined) ??
    null
  )
}

export function speechSupported(): boolean {
  return getRecognitionCtor() !== null
}

const FATAL_ERRORS: Record<string, string> = {
  "not-allowed":
    "Microphone permission is blocked. Click the icon left of the address bar → Site settings → allow Microphone, then reload.",
  "service-not-allowed":
    "This browser blocks the speech service. Use Google Chrome or Microsoft Edge.",
  "audio-capture":
    "No microphone was found. Check that a mic is connected and selected in system settings.",
  network:
    "Speech recognition couldn’t reach its service — it needs an internet connection (and Chrome/Edge; browsers like Brave block it).",
  "language-not-supported": "This ear language isn’t supported by the browser.",
}

export class SpeechListener {
  private rec: SpeechRecognitionLike | null = null
  private stopping = false
  // Everything below exists because of one complaint: switching to another
  // tab silently killed the ear. Chrome suspends recognition in a background
  // tab, `onend` may never arrive, and a restart attempt can be refused —
  // leaving the button showing "Listening" over a microphone that is dead.
  private lastAliveAt = 0
  private watchdog: number | null = null
  private onVisibility: (() => void) | null = null

  start(lang: string, cb: RecognitionCallbacks) {
    const Ctor = getRecognitionCtor()
    if (!Ctor) {
      cb.onError("Speech recognition is not supported in this browser — use Chrome or Edge.")
      return
    }
    this.stopping = false
    this.lastAliveAt = Date.now()

    /** Bring the recogniser back, whatever state it thinks it is in. */
    const revive = () => {
      if (this.stopping || !this.rec) return
      try {
        this.rec.start()
      } catch {
        // Already running, or refused because the tab is still hidden. Either
        // way the watchdog will come round again.
      }
    }

    // A tab that comes back to the front must be listening again immediately,
    // not at the next accidental restart.
    this.onVisibility = () => {
      if (!this.stopping && document.visibilityState === "visible") revive()
    }
    document.addEventListener("visibilitychange", this.onVisibility)

    // Nothing heard for a while? Assume it died quietly and restart it. This
    // is the only reliable signal: a suspended recogniser reports nothing at
    // all, not an error.
    this.watchdog = window.setInterval(() => {
      if (this.stopping) return
      if (Date.now() - this.lastAliveAt > 8000) {
        this.lastAliveAt = Date.now()
        revive()
      }
    }, 4000)

    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.onstart = () => {
      cb.onStatus?.("mic open — speak")
    }
    rec.onresult = (event) => {
      this.lastAliveAt = Date.now()   // proof the ear is still alive
      // Report interim and final segments separately, so callers can
      // choose to act only on committed (final) text.
      let interim = ""
      let final = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript
        if (event.results[i].isFinal) final += chunk
        else interim += chunk
      }
      if (interim.trim()) cb.onTranscript(interim, false)
      if (final.trim()) cb.onTranscript(final, true)
    }
    rec.onerror = (e) => {
      const fatal = FATAL_ERRORS[e.error]
      if (fatal) {
        this.stopping = true
        cb.onError(fatal)
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        cb.onStatus?.(`speech error: ${e.error} (retrying)`)
      }
    }
    rec.onend = () => {
      if (this.stopping) return
      // A hidden tab can refuse the restart. Try immediately, and if that
      // throws, leave it to the watchdog rather than giving up for good —
      // giving up here is what made the ear die on a tab switch.
      try {
        rec.start()
      } catch {
        window.setTimeout(revive, 500)
      }
    }
    this.rec = rec
    rec.start()
  }

  stop() {
    this.stopping = true
    if (this.watchdog !== null) {
      window.clearInterval(this.watchdog)
      this.watchdog = null
    }
    if (this.onVisibility) {
      document.removeEventListener("visibilitychange", this.onVisibility)
      this.onVisibility = null
    }
    this.rec?.stop()
    this.rec = null
  }
}