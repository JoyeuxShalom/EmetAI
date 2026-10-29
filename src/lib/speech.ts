// Emet's own voice — speech synthesis, with a switch and a choice of speaker.
//
// ⚠ The thing that makes this dangerous in a church: the microphone is open.
// If Emet answers out loud while the ear is listening, the ear hears Emet,
// transcribes it, and may act on it — a loop that ends with the projector
// changing by itself. `isSpeaking()` exists so the transcript handler can
// ignore everything heard while Emet is talking. Nothing here should be used
// without that guard.

export type VoiceGender = "off" | "female" | "male"

const STORAGE_KEY = "emetai_voice"

/** Browsers do not label voices by gender, so match on the names they ship.
 *  Anything unmatched falls back to the platform default for the language. */
const FEMALE_HINTS =
  /\b(female|woman|zira|susan|hazel|linda|heera|aria|jenny|michelle|samantha|karen|moira|tessa|fiona|amelie|audrey|marie|julie|sandy|google uk english female)\b/i
const MALE_HINTS =
  /\b(male|man|david|mark|george|james|guy|ryan|daniel|alex|fred|thomas|paul|nicolas|henri|google uk english male)\b/i

export function loadVoicePreference(): VoiceGender {
  const saved = localStorage.getItem(STORAGE_KEY)
  return saved === "female" || saved === "male" ? saved : "off"
}

export function saveVoicePreference(v: VoiceGender) {
  localStorage.setItem(STORAGE_KEY, v)
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window
}

/** Voices arrive asynchronously in Chrome; the first call often sees none. */
export function voicesFor(lang: string): SpeechSynthesisVoice[] {
  if (!speechSupported()) return []
  const wanted = lang.slice(0, 2).toLowerCase()
  const all = window.speechSynthesis.getVoices()
  const matching = all.filter((v) => v.lang.slice(0, 2).toLowerCase() === wanted)
  // Kinyarwanda has no synthesis voice on any mainstream browser, so fall
  // back to any English voice rather than saying nothing at all.
  return matching.length ? matching : all.filter((v) => v.lang.startsWith("en"))
}

export function pickVoice(lang: string, gender: VoiceGender): SpeechSynthesisVoice | null {
  if (gender === "off") return null
  const candidates = voicesFor(lang)
  if (!candidates.length) return null
  const want = gender === "female" ? FEMALE_HINTS : MALE_HINTS
  const avoid = gender === "female" ? MALE_HINTS : FEMALE_HINTS
  return (
    candidates.find((v) => want.test(v.name)) ??
    candidates.find((v) => !avoid.test(v.name)) ??
    candidates[0]
  )
}

let speaking = false
let releaseAt = 0

/** True while Emet is talking, plus a short tail — the microphone keeps
 *  hearing the last syllable for a moment after synthesis reports it is done. */
export function isSpeaking(): boolean {
  return speaking || Date.now() < releaseAt
}

/** Say something out loud. Silent and harmless when the voice is off. */
export function say(text: string, lang: string, gender: VoiceGender) {
  if (gender === "off" || !speechSupported() || !text.trim()) return
  const synth = window.speechSynthesis
  // A queue of stale confirmations is worse than none: only the newest
  // matters when the service has already moved on.
  synth.cancel()

  const utterance = new SpeechSynthesisUtterance(text.slice(0, 300))
  const voice = pickVoice(lang, gender)
  if (voice) {
    utterance.voice = voice
    utterance.lang = voice.lang
  } else {
    utterance.lang = lang
  }
  utterance.rate = 1.05   // a touch brisk; this is a confirmation, not a reading
  utterance.pitch = 1

  speaking = true
  const done = () => {
    speaking = false
    releaseAt = Date.now() + 400 // let the room settle before trusting the mic
  }
  utterance.onend = done
  utterance.onerror = done
  synth.speak(utterance)
}

export function stopSpeaking() {
  if (!speechSupported()) return
  window.speechSynthesis.cancel()
  speaking = false
  releaseAt = 0
}

/** Ask the browser to load its voice list. Chrome populates it lazily and
 *  fires `voiceschanged` once ready. */
export function warmVoices(onReady?: () => void) {
  if (!speechSupported()) return
  const synth = window.speechSynthesis
  if (synth.getVoices().length) {
    onReady?.()
    return
  }
  const handler = () => {
    synth.removeEventListener("voiceschanged", handler)
    onReady?.()
  }
  synth.addEventListener("voiceschanged", handler)
}
