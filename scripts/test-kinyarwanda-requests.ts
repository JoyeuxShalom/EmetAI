// Does EmetAI understand a request made in Kinyarwanda?
//
// From a real service, 2026-10-30. The preacher asked for the same passage
// twice. In English it worked — 1 Samuel 22 went on the wall. In Kinyarwanda,
// correctly transcribed, nothing happened at all: the sentence matched no
// pattern, fell through the ten-word rule at fourteen words, and was thrown
// away before it could reach the agent.
//
// The ear was not the problem. Everything downstream of it was.
//
// Run:  npx tsx scripts/test-kinyarwanda-requests.ts

import { detectBareCommand, detectWakeCommand, looksLikeInstruction } from "../src/lib/wakeWord"

let PASS = 0
let FAIL = 0

function check(label: string, ok: boolean, extra: unknown = "") {
  if (ok) {
    PASS++
    console.log(`  ok  ${label}`)
  } else {
    FAIL++
    console.log(`FAIL  ${label} ${extra === "" ? "" : JSON.stringify(extra)}`)
  }
}

/** Reaches the agent by any route. */
const understood = (line: string) =>
  looksLikeInstruction(line) || !!detectBareCommand(line) || !!detectWakeCommand(line)

console.log("— the exact sentence from the service —")

const SPOKEN_RW =
  "Ndavuga ngo baduhe icyo cyandikwa igihe Dawidi yahuraga n'abasirikare be mu buvumo bwa Aduramu."
const SPOKEN_EN =
  "people or those soldiers in the cave of Adullam. Can you give us that scripture please so that we can read it?"

check("the English request is understood (it always was)", understood(SPOKEN_EN))
check("the SAME request in Kinyarwanda is now understood", understood(SPOKEN_RW))
check("and it is long enough to have failed the old ten-word rule",
  SPOKEN_RW.split(/\s+/).length > 10, SPOKEN_RW.split(/\s+/).length)

console.log("\n— the verb carries its subject prefix —")

// Kinyarwanda puts the subject on the verb, so one stem appears as duhe /
// uduhe / baduhe / muduhe / tuduhe. The first version of this listed the
// prefixes it happened to think of and missed "muduhe" — the form a preacher
// addressing the room actually uses, and the one a real service produced,
// transcribed perfectly, to no effect at all.
const PREFIXED = [
  "Muduhe icyo cyanditswe.",
  "Tuduhe umurongo wa Zaburi makumyabiri na gatatu",
  "Baduhe icyo cyandikwa cya Dawidi",
  "Uduhe igice cya gatatu cy'igitabo cya Yohana",
  "duhe umurongo uvuga ku kwizera",
]
let prefixed = 0
for (const line of PREFIXED) {
  if (understood(line)) prefixed++
  else console.log(`      missed: ${line}`)
}
check(`every subject prefix is understood (${prefixed}/${PREFIXED.length})`,
  prefixed === PREFIXED.length, prefixed)

// The ear mis-heard the same word three ways in one service — cyanditswe,
// cyandiswe, cyandikwa. Refusing the imperfect spellings would mean
// understanding the request only when it was heard perfectly, which is
// exactly when help is least needed.
check("a near-miss spelling of 'scripture' still counts",
  understood("Muduhe icyo cyandiswe") && understood("Baduhe icyo cyandikwa"))

console.log("\n— the ways a preacher actually asks —")

const REQUESTS = [
  "baduhe umurongo wa Dawidi mu buvumo bwa Adulamu",
  "mbwira icyo iki gitabo kivuga ku rukundo rw'Imana",
  "nyereka umurongo uvuga ku bwiza bw'Imana",
  "dusome igice cya gatatu cy'igitabo cya Yohana",
  "tubwire ijambo Imana yavuze kuri Dawidi",
  "sobanura ijambo Elohim risobanura iki",
  "twereke ibyanditswe bivuga ku kwizera",
  "shakisha umurongo uvuga ku gukiranuka",
  "ndashaka ko mwaduha umurongo uvuga ku bwami bw'Imana",
]
let got = 0
for (const line of REQUESTS) {
  if (understood(line)) got++
  else console.log(`      missed: ${line}`)
}
check(`requests are understood (${got}/${REQUESTS.length})`, got === REQUESTS.length, got)

console.log("\n— and ordinary preaching still goes nowhere near the agent —")

// This is the half that matters most. A benediction contains a giving verb;
// a sermon is full of talk about the word of God. Neither is an instruction,
// and treating them as one would put a verse on the wall every few sentences
// and burn the API quota doing it.
const PREACHING = [
  "Imana ibaduhe umugisha mwese muri iki gitondo",
  "Imana iduhe amahoro n'urukundo muri uyu munsi",
  "turashima Imana ku bw'urukundo rwayo no kugiraneza kwe",
  "ijambo ry'Imana ni ryiza kandi rirakomeza",
  "Dawidi yari umwami w'Abisiraheli kandi yakundaga Imana",
  "bavandimwe nimuhaguruke dusenge hamwe",
  "amen alleluia Imana ishimwe",
  "ubu rero reka tuvuge ku byanditswe mu buzima bwacu",
  "umugisha w'Imana uri kuri mwese",
]
let fired = 0
for (const line of PREACHING) {
  if (understood(line)) {
    fired++
    console.log(`      WOULD FIRE: ${line}`)
  }
}
check(`preaching fires nothing (${PREACHING.length - fired}/${PREACHING.length} quiet)`,
  fired === 0, fired)

console.log("\n— a benediction is not a request —")

// The specific trap: "ibaduhe" (give you) is a giving verb, and a blessing is
// the single most common sentence in a Rwandan service containing one.
check("'Imana ibaduhe umugisha' is not treated as a request",
  !understood("Imana ibaduhe umugisha"))
check("but 'baduhe umurongo' is",
  understood("baduhe umurongo wa Zaburi makumyabiri na gatatu"))
check("a giving verb with no scripture word stays quiet",
  !understood("baduhe amahoro n'ibyishimo byinshi"))
check("a scripture word with no request stays quiet",
  !understood("ijambo ry'Imana rivuga ibintu byinshi ku buzima"))

console.log("\n— French keeps working too —")

check("a French request is understood",
  understood("donne-moi le verset qui parle de l'amour de Dieu"))
check("French preaching is not",
  !understood("mes freres et soeurs, Dieu vous aime beaucoup aujourd'hui"))

console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
