// Emet's own voice: picking a speaker, and the guard that stops it hearing
// itself.
// Run:  npx tsx scripts/test-speech.ts

let pass = 0
let fail = 0

function check(label: string, ok: boolean, extra: unknown = "") {
  if (ok) {
    pass++
    console.log(`  ok  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label} ${extra ? JSON.stringify(extra) : ""}`)
  }
}

// ---- A browser's speech synthesis, in miniature -----------------------------
type Voice = { name: string; lang: string }
const VOICES: Voice[] = [
  { name: "Microsoft David - English (United States)", lang: "en-US" },
  { name: "Microsoft Zira - English (United States)", lang: "en-US" },
  { name: "Google UK English Male", lang: "en-GB" },
  { name: "Google UK English Female", lang: "en-GB" },
  { name: "Microsoft Paul - French (France)", lang: "fr-FR" },
  { name: "Amelie", lang: "fr-FR" },
]

const spoken: { text: string; voice: string | null; lang: string }[] = []
let cancels = 0
let pendingEnd: (() => void) | null = null

class FakeUtterance {
  text: string
  voice: Voice | null = null
  lang = ""
  rate = 1
  pitch = 1
  onend: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

const store: Record<string, string> = {}
const g = globalThis as Record<string, unknown>
g.window = {
  speechSynthesis: {
    getVoices: () => VOICES,
    cancel: () => {
      cancels++
    },
    speak: (u: FakeUtterance) => {
      spoken.push({ text: u.text, voice: u.voice?.name ?? null, lang: u.lang })
      pendingEnd = () => u.onend?.()
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
}
g.SpeechSynthesisUtterance = FakeUtterance
g.localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v
  },
}

const speech = await import("../src/lib/speech")

// ---------------------------------------------------------------------------
console.log("\n— choosing a speaker —")

const female = speech.pickVoice("en-US", "female")
const male = speech.pickVoice("en-US", "male")
check("a female voice is found", /zira/i.test(female?.name ?? ""), female?.name)
check("a male voice is found", /david/i.test(male?.name ?? ""), male?.name)
check("they are not the same voice", female?.name !== male?.name)
check("off picks nothing at all", speech.pickVoice("en-US", "off") === null)

const fr = speech.pickVoice("fr-FR", "female")
check("the language is honoured", fr?.lang.startsWith("fr") === true, fr)
check("and gender within it", /amelie/i.test(fr?.name ?? ""), fr?.name)

// Kinyarwanda has no synthesis voice anywhere; saying nothing would be worse.
const rw = speech.pickVoice("rw-RW", "male")
check("an unsupported language still gets a voice", rw !== null, rw?.name)

// ---------------------------------------------------------------------------
console.log("\n— speaking —")

spoken.length = 0
speech.say("Showing John 3:16", "en-US", "female")
check("it speaks", spoken.length === 1, spoken)
check("with the chosen voice", /zira/i.test(spoken[0]?.voice ?? ""), spoken[0])

spoken.length = 0
speech.say("this should be silent", "en-US", "off")
check("the off setting really is silent", spoken.length === 0, spoken)

spoken.length = 0
speech.say("   ", "en-US", "female")
check("empty text says nothing", spoken.length === 0, spoken)

const before = cancels
speech.say("newer line", "en-US", "female")
check("a new line cancels the stale one", cancels > before)

spoken.length = 0
speech.say("x".repeat(1000), "en-US", "female")
check("very long text is trimmed", (spoken[0]?.text.length ?? 0) <= 300, spoken[0]?.text.length)

// ---------------------------------------------------------------------------
console.log("\n— the echo guard —")
// Without this the microphone hears Emet's own confirmation, parses it as a
// command and obeys it. That loop ends with the projector changing by itself.

speech.stopSpeaking()
check("quiet before speaking", speech.isSpeaking() === false)

speech.say("Emet: opening your account", "en-US", "male")
check("speaking is flagged the whole time", speech.isSpeaking() === true)

pendingEnd?.()  // synthesis reports it has finished
check("and stays flagged briefly afterwards — the room is still ringing",
      speech.isSpeaking() === true)

// Only once the tail has elapsed is the microphone trusted again.
const realNow = Date.now
Date.now = () => realNow() + 5000
check("the guard lifts after the tail", speech.isSpeaking() === false)
Date.now = realNow

speech.say("something", "en-US", "male")
speech.stopSpeaking()
check("stopping clears the flag at once", speech.isSpeaking() === false)

// ---------------------------------------------------------------------------
console.log("\n— remembering the choice —")

speech.saveVoicePreference("male")
check("the choice is stored", speech.loadVoicePreference() === "male")
speech.saveVoicePreference("off")
check("and off is stored too", speech.loadVoicePreference() === "off")
store["emetai_voice"] = "nonsense"
check("a corrupt stored value falls back to off",
      speech.loadVoicePreference() === "off", store["emetai_voice"])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
