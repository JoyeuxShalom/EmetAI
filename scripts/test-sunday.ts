// Measured against a real Sunday service, not sentences I invented.
//
// 229 lines of True Salvation Church, 1 November 2026, preacher and
// interpreter, Kinyarwanda and English. The ear produced 14 verse detections
// across 86 minutes and only ONE of them was right:
//
//   48%  Matayo 10:16   <- "God said, Go and be as wise as serpents"   CORRECT
//   48%  Lamentations 3:22  <- "You do not have the option of failing"
//   47%  Isaiah 5:5     <- "is telling you what he wants to do for you"
//   47%  Ezekiel 12:22  <- "What have you done that has failed?"
//   42%  Mark 9:16      <- "A wise person is not a crammer"
//
// Ordinary preaching, matched to scripture. That is the product's core
// behaviour misfiring, and the operator sees a panel of noise.
//
// This replays every line through the real matcher and reports how many fire.
// There is no "right answer" to check against — the preacher was preaching,
// not quoting — so the measure is simply: how much does it invent?
//
// Run:  npx tsx scripts/test-sunday.ts

import { readFileSync } from "node:fs"

import { normalize, type Bible, type Verse } from "../src/data/bible"
import { CONFIDENT, matchQuote } from "../src/lib/quoteMatch"

function load(id: string): Bible {
  const file = JSON.parse(readFileSync(`public/bibles/${id}.json`, "utf-8"))
  const verses: Verse[] = []
  file.books.forEach((book: any, i: number) => {
    const bookNr = book.nr ?? i + 1
    for (const ch of book.chapters)
      for (const row of ch.verses)
        verses.push({
          bookNr, book: book.name, chapter: ch.chapter, verse: row.v,
          text: row.t, norm: normalize(row.t), translation: file.name,
        })
  })
  return { meta: { id: file.id, name: file.name }, books: file.books, verses }
}

const BIBLES = ["by", "kjv", "ls1910"].map(load)

/** Exactly what the Studio does: every quote Bible, best score wins. */
function hear(text: string) {
  let best: { verse: Verse; score: number; confident: boolean } | null = null
  for (const b of BIBLES) {
    const m = matchQuote(b, text)
    if (m && (!best || m.score > best.score)) best = m
  }
  return best
}

// The transcript is real congregation speech, so it lives under server/data/
// and is gitignored along with the database and the master key. It is kept out
// of the repository on purpose; this test ships so the measurement can be
// repeated by anyone who has a service of their own.
const SOURCE = "server/data/sunday-lines.txt"
let raw: string
try {
  raw = readFileSync(SOURCE, "utf-8")
} catch {
  console.log(`no service transcript at ${SOURCE} — nothing to measure.`)
  console.log("Export one from a service this server recorded:")
  console.log(`  sqlite3 server/data/emetai.db \\`)
  console.log(`    "select heard from service_line where service_id = '<id>'" \\`)
  console.log(`    > ${SOURCE}`)
  process.exit(0)
}
const lines = raw
  .split("\n").map((l) => l.trim()).filter((l) => l.length > 25)

// The only line in the whole service that genuinely quoted scripture.
const REAL_QUOTE = lines.find((l) => /wise as serpents/i.test(l))

let fired = 0
let projected = 0
const examples: string[] = []
for (const line of lines) {
  const m = hear(line)
  if (!m) continue
  fired++
  if (m.confident) projected++
  if (examples.length < 8) {
    examples.push(
      `  ${(m.score * 100).toFixed(0)}%${m.confident ? " PROJECTED" : "         "}  ` +
      `${m.verse.book} ${m.verse.chapter}:${m.verse.verse}  <- ${line.slice(0, 58)}`
    )
  }
}

console.log(`a real 86-minute service, ${lines.length} lines\n`)
console.log(examples.join("\n"))
console.log(`\n  lines that produced a verse : ${fired} of ${lines.length}` +
  `  (${(100 * fired / lines.length).toFixed(0)}%)`)
console.log(`  of those, auto-projected    : ${projected}`)
console.log(`  CONFIDENT threshold         : ${CONFIDENT}`)

if (REAL_QUOTE) {
  const m = hear(REAL_QUOTE)
  console.log(`\n  the one genuine quote in the service:`)
  console.log(`    "${REAL_QUOTE.slice(0, 64)}"`)
  console.log(`    -> ${m ? `${m.verse.book} ${m.verse.chapter}:${m.verse.verse} at ` +
    `${(m.score * 100).toFixed(0)}%` : "NOT FOUND"}`)
}
