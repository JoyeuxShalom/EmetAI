// Replay a whole recorded service through the real matcher, with the same
// passage-context tracking the Studio does, and report what changes.
//
// test-recitation.ts checks eleven lines chosen because they were
// interesting. This one runs every line of a real service so the lines
// nobody chose get a vote too — the ordinary preaching that must stay
// silent is most of a service, and it is the thing a hand-picked list
// flatters.
//
// Run:  npx tsx scripts/replay-service.ts [tsv]
//   tsv: seq/action/result/score/lang/speaker/heard, as pull_service.py writes

import { readFileSync } from "node:fs"

import { normalize, type Bible, type Verse } from "../src/data/bible"
import { detectReference } from "../src/lib/listener"
import { CONFIDENT, matchQuote, type PassageContext } from "../src/lib/quoteMatch"

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

const SOURCE = process.argv[2] ?? "server/data/service-today.tsv"
let raw: string
try {
  raw = readFileSync(SOURCE, "utf-8")
} catch {
  console.log(`no service at ${SOURCE} — nothing to replay.`)
  console.log("Export one with scripts/pull_service.py against the server db.")
  process.exit(0)
}

const BIBLES = ["by", "kjv", "ls1910"].map(load)

type Row = { seq: number; action: string; result: string; heard: string }
const rows: Row[] = raw
  .split("\n")
  .slice(1)
  .map((l) => l.split("\t"))
  .filter((c) => c.length >= 7 && c[6].trim().length > 0)
  .map((c) => ({
    seq: Number(c[0]), action: c[1], result: c[2], heard: c[6].trim(),
  }))
  // The detection rows are the SAME utterance logged a second time, already
  // quote-wrapped and truncated. Replaying them would double every hit.
  .filter((r) => !(r.action === "detected" && r.heard.startsWith("“")))

function pass(useContext: boolean) {
  let context: PassageContext | null = null
  let fired = 0
  let projected = 0
  const hits: string[] = []

  for (const r of rows) {
    const ref = detectReference(r.heard)

    let best: { verse: Verse; score: number; confident: boolean } | null = null
    for (const b of BIBLES) {
      const m = matchQuote(b, r.heard, undefined,
        useContext ? (context ?? undefined) : undefined)
      if (m && (!best || m.score > best.score)) best = m
    }

    if (best) {
      fired++
      if (best.confident) projected++
      hits.push(
        `  ${(best.score * 100).toFixed(0).padStart(3)}%` +
        `${best.confident ? " P" : "  "} ${r.seq
          .toString().padStart(3)}  ` +
        `${best.verse.book} ${best.verse.chapter}:${best.verse.verse}`.padEnd(26) +
        `<- ${r.heard.slice(0, 52)}`
      )
    }

    // The Studio's own rule: an explicit reference or a confident match
    // moves the context; nothing weaker does.
    if (ref) {
      const v = BIBLES[0].verses.find(
        (x) => x.bookNr === ref.bookNr && x.chapter === (ref.chapter ?? 1))
      if (v) context = { bookNr: v.bookNr, chapter: v.chapter, at: Date.now() }
    } else if (best?.confident) {
      context = {
        bookNr: best.verse.bookNr, chapter: best.verse.chapter, at: Date.now(),
      }
    }
  }
  return { fired, projected, hits }
}

console.log(`${SOURCE} — ${rows.length} spoken lines, CONFIDENT ${CONFIDENT}\n`)
const before = pass(false)
const after = pass(true)

console.log("── with passage context, every verse offered ────────────────")
console.log(after.hits.join("\n"))

console.log("\n==============================================================")
console.log(`  lines offering a verse   ${before.fired}  ->  ${after.fired}`)
console.log(`  of those, auto-projected ${before.projected}  ->  ${after.projected}`)
