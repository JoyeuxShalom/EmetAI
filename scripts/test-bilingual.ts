// Can one ear follow a Kinyarwanda preacher AND an English interpreter?
//
// The Studio matches every utterance against the Kinyarwanda, English and
// French Bibles at once and keeps the best. This replays that exact logic over
// real verse text in both languages and asks the only question that matters:
// does the preacher's sentence and the interpreter's repeat of it land on the
// SAME reference? If they do not, an interpreted service produces two
// different verses for one thought, which is worse than useless on a wall.
//
// Run:  npx tsx scripts/test-bilingual.ts

import { readFileSync } from "node:fs"

import { normalize, type Bible, type Verse } from "../src/data/bible"
import { matchQuote } from "../src/lib/quoteMatch"

function load(id: string): Bible {
  const file = JSON.parse(readFileSync(`public/bibles/${id}.json`, "utf-8"))
  const verses: Verse[] = []
  file.books.forEach((book: any, i: number) => {
    const bookNr = book.nr ?? i + 1
    for (const ch of book.chapters)
      for (const row of ch.verses)
        verses.push({
          bookNr,
          book: book.name,
          chapter: ch.chapter,
          verse: row.v,
          text: row.t,
          norm: normalize(row.t),
          translation: file.name,
        })
  })
  return { meta: { id: file.id, name: file.name }, books: file.books, verses }
}

const BIBLES = ["by", "kjv", "ls1910"].map(load)
const [RW, EN] = BIBLES

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

/** Exactly what OperatorView does: try every quote Bible, keep the best. */
function hear(text: string) {
  let best: { verse: Verse; score: number; confident: boolean; from: string } | null = null
  for (const b of BIBLES) {
    const m = matchQuote(b, text)
    if (m && (!best || m.score > best.score)) {
      best = { verse: m.verse, score: m.score, confident: m.confident, from: b.meta.id }
    }
  }
  return best
}

const ref = (v: Verse) => `${v.bookNr}:${v.chapter}:${v.verse}`

function textOf(bible: Bible, bookNr: number, chapter: number, verse: number): string {
  const row = bible.verses.find(
    (v) => v.bookNr === bookNr && v.chapter === chapter && v.verse === verse
  )
  if (!row) throw new Error(`missing ${bookNr}:${chapter}:${verse} in ${bible.meta.id}`)
  return row.text
}

// Verses a Rwandan service actually uses, spread across both testaments.
const VERSES: [string, number, number, number][] = [
  ["John 3:16", 43, 3, 16],
  ["Psalm 23:1", 19, 23, 1],
  ["Deuteronomy 23:12", 5, 23, 12],
  ["Romans 8:28", 45, 8, 28],
  ["Philippians 4:13", 50, 4, 13],
  ["Isaiah 53:5", 23, 53, 5],
  ["Genesis 1:1", 1, 1, 1],
  ["Matthew 6:33", 40, 6, 33],
  ["Jeremiah 29:11", 24, 29, 11],
  ["Proverbs 3:5", 20, 3, 5],
]

// -------------------------------------------- the two languages agree ------
console.log("— the preacher in Kinyarwanda, the interpreter in English —")

let agreed = 0
let rwHeard = 0
let enHeard = 0

for (const [label, bookNr, chapter, verse] of VERSES) {
  const want = `${bookNr}:${chapter}:${verse}`
  const rw = hear(textOf(RW, bookNr, chapter, verse))
  const en = hear(textOf(EN, bookNr, chapter, verse))

  const rwOk = !!rw && ref(rw.verse) === want
  const enOk = !!en && ref(en.verse) === want
  if (rwOk) rwHeard++
  if (enOk) enHeard++
  if (rwOk && enOk) agreed++

  if (!rwOk || !enOk) {
    console.log(
      `      ${label}: rw=${rw ? ref(rw.verse) : "none"} en=${en ? ref(en.verse) : "none"}`
    )
  }
}

check(`Kinyarwanda alone finds the verse (${rwHeard}/${VERSES.length})`,
  rwHeard === VERSES.length, rwHeard)
check(`English alone finds the verse (${enHeard}/${VERSES.length})`,
  enHeard === VERSES.length, enHeard)
check(`both languages agree on the same reference (${agreed}/${VERSES.length})`,
  agreed === VERSES.length, agreed)

// The languages must not merely agree — each must be found through its OWN
// Bible, or "both languages" is an illusion produced by one of them.
const rwSource = hear(textOf(RW, 43, 3, 16))
const enSource = hear(textOf(EN, 43, 3, 16))
check("the Kinyarwanda quote is matched in the Kinyarwanda Bible",
  rwSource?.from === "by", rwSource?.from)
check("the English quote is matched in the English Bible",
  enSource?.from === "kjv", enSource?.from)


// ------------------------------------------------- mid-sentence mixing -----
// Rwandan preachers code-switch constantly: a Kinyarwanda sentence with an
// English clause inside it. Half a verse in each language must still be found.
console.log("\n— one sentence, both languages —")

/** Split at a clause boundary, the way a person actually switches language.
 *  An earlier version of this test cut at the exact middle word, which turned
 *  Genesis 1:1 into "Mbere na mbere Imana the heaven and the earth" — the verb
 *  deleted entirely. That is not code-switching, it is corruption, and no
 *  matcher should find a verse in it. */
function clauses(text: string): [string, string] | null {
  const at = text.indexOf(", ")
  if (at < 12 || text.length - at < 14) return null
  return [text.slice(0, at), text.slice(at + 2)]
}

let mixedTried = 0
let mixedFound = 0
for (const [label, bookNr, chapter, verse] of VERSES) {
  const rwParts = clauses(textOf(RW, bookNr, chapter, verse))
  const enParts = clauses(textOf(EN, bookNr, chapter, verse))
  if (!rwParts || !enParts) continue // no clause boundary to switch at
  mixedTried++
  const want = `${bookNr}:${chapter}:${verse}`
  // Kinyarwanda opening clause, English closing clause.
  const got = hear(`${rwParts[0]}, ${enParts[1]}`)
  if (got && ref(got.verse) === want) mixedFound++
  else console.log(`      ${label}: got ${got ? ref(got.verse) : "nothing"}`)
}
check(`a code-switched sentence still finds the verse (${mixedFound}/${mixedTried})`,
  mixedTried >= 5 && mixedFound >= mixedTried - 1, `${mixedFound}/${mixedTried}`)

// And the other half of the same coin: when a switch leaves too little of
// either language to identify anything, refusing is the RIGHT answer. A wall
// showing the wrong verse is worse than a wall showing nothing.
const TOO_LITTLE = [
  "Mbere na mbere Imana the heaven and the earth",
  "Zaburi ya Dawidi. Uwiteka ni I shall not want",
]
let guessed = 0
for (const fragment of TOO_LITTLE) {
  const got = hear(fragment)
  if (got?.confident) {
    guessed++
    console.log(`      would have projected ${ref(got.verse)} from: ${fragment}`)
  }
}
check("a fragment too mangled to identify projects nothing", guessed === 0, guessed)


// ------------------------------------------------ it must stay careful -----
// The whole point of listening in two languages is more right answers, not
// more answers. Ordinary bilingual speech must still match nothing.
console.log("\n— and it still refuses to guess —")

const NOT_SCRIPTURE = [
  "murakoze cyane, thank you for coming this morning",
  "please turn with me, dufungure Bibiliya zacu",
  "we are going to take the offering now",
  "Imana ishimwe, praise God, everybody stand up",
  "the choir will sing and then we will pray",
]
let fired = 0
for (const line of NOT_SCRIPTURE) {
  const got = hear(line)
  if (got?.confident) {
    fired++
    console.log(`      would have projected ${ref(got.verse)} from: ${line}`)
  }
}
check("ordinary bilingual speech projects nothing", fired === 0, fired)

console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
