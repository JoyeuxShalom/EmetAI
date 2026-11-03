// Real recitations from a real service, and what the matcher does with them.
//
// Taken verbatim from the 2 November service, where the preacher read
// Genesis 1 and Proverbs 8 aloud, verse by verse, in Kinyarwanda and English
// together. Some verses appeared on the wall; several did not; one came back
// as the wrong book entirely.
//
// The operator's complaint was precise: "whenever it hears the preacher
// reciting a verse, it must give it immediately" — and "it just gives you a
// verse which is not right".
//
// Run:  npx tsx scripts/test-recitation.ts

import { readFileSync } from "node:fs"

import { normalize, type Bible, type Verse } from "../src/data/bible"
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

const BIBLES = ["by", "kjv", "ls1910"].map(load)

/** Exactly what the Studio does: every quote Bible, best score wins. */
function hear(text: string, context?: PassageContext) {
  let best: { verse: Verse; score: number; confident: boolean } | null = null
  for (const b of BIBLES) {
    const m = matchQuote(b, text, 0.42, context)
    if (m && (!best || m.score > best.score)) best = m
  }
  return best
}

type Case = {
  what: string
  said: string
  /** "" means: this is not scripture, nothing should fire. */
  want: string
  /** The passage the service was in when this was said. */
  context?: PassageContext
}

const GEN1: PassageContext = { bookNr: 1, chapter: 1, at: Date.now() }
const PRO8: PassageContext = { bookNr: 20, chapter: 8, at: Date.now() }

const CASES: Case[] = [
  // --- recited and MISSED on the day -------------------------------------
  {
    what: "Genesis 1:1 recited verbatim, in English",
    said: "In the beginning God created the heavens and the earth.",
    want: "1:1", context: GEN1,
  },
  {
    what: "Genesis 1:2b, the Spirit over the waters",
    said: "Mazu muke w'Imana yagenda agenda agejeje amazi. And the spirit of " +
      "God was hovering over the waters. Muvug'Imana yareba yareba isi hutsa.",
    want: "1:2", context: GEN1,
  },
  {
    what: "Proverbs 8:23, appointed from eternity",
    said: "Uhereye kera kose narimitsewe, I was appointed from eternity. " +
      "Uhereye imbere na mbere isi itararemwa, From the beginning, before " +
      "the world began.",
    want: "8:23", context: PRO8,
  },
  // --- recited and matched to the WRONG book -----------------------------
  {
    what: "a fragment of Genesis 1:2, mid Genesis-1 reading",
    said: "depths of the surface of the deep",
    want: "1:2", context: GEN1,
  },
  // --- caught correctly on the day: must stay caught ---------------------
  {
    what: "Genesis 1:3, let there be light",
    said: "And what are created? Imana iravuga iti habehumucyo, umucyo " +
      "ubaho. And God said let there be light, and there was light.",
    want: "1:3", context: GEN1,
  },
  {
    what: "Genesis 1:5, the evening and the morning",
    said: "God called the light day, and the darkness he called night. " +
      "And there was evening and there was morning, the first day.",
    want: "1:5", context: GEN1,
  },
  {
    what: "Proverbs 8:30, the craftsman at his side",
    said: "ari umukozi w'umuhanga. Then I was the craftsman inside. " +
      "umukozi w'umuhanga The craftsman at his side.",
    want: "8:30", context: PRO8,
  },
  {
    what: "Luke 22:48, betrayed with a kiss",
    said: "betraying the son of man with a kiss",
    want: "22:48",
  },
  // --- NOT scripture: must stay silent -----------------------------------
  {
    what: "a prayer of thanks, not a quotation",
    said: "Tuguhaye amashimwe mwami, turagushimiye Imana yacu kuko " +
      "uduhaye ubuzima n'amahoro muri uyu munsi.",
    want: "", context: GEN1,
  },
  {
    what: "the preacher explaining, not quoting",
    said: "Ubwenge ni ukumenya ko ubwenge bumenya kubaza ikibazo. " +
      "I told you that wisdom is knowing how to ask a question.",
    want: "", context: PRO8,
  },
  {
    what: "ordinary talk during the Genesis reading",
    said: "We talked about this long ago. The answer to this question " +
      "is something we have to look at together today.",
    want: "", context: GEN1,
  },
]

function ref(m: { verse: Verse } | null) {
  return m ? `${m.verse.chapter}:${m.verse.verse}` : "—"
}

function run(withContext: boolean) {
  let right = 0, wrong = 0, missed = 0, noise = 0
  const rows: string[] = []
  for (const c of CASES) {
    const m = hear(c.said, withContext ? c.context : undefined)
    const got = ref(m)
    let mark: string
    if (c.want === "") {
      if (m) { mark = "NOISE "; noise++ } else { mark = "ok    "; right++ }
    } else if (!m) {
      mark = "MISS  "; missed++
    } else if (got === c.want) {
      mark = "ok    "; right++
    } else {
      mark = "WRONG "; wrong++
    }
    const score = m ? `${(m.score * 100).toFixed(0)}%${m.confident ? " P" : "  "}` : "    "
    rows.push(`  ${mark} want ${(c.want || "nothing").padEnd(8)} got ${got.padEnd(8)} ${score}  ${c.what}`)
  }
  console.log(rows.join("\n"))
  console.log(`\n  right ${right}   wrong ${wrong}   missed ${missed}   false fires ${noise}`)
  return { right, wrong, missed, noise }
}

console.log(`the 2 November service — ${CASES.length} real lines`)
console.log(`CONFIDENT = ${CONFIDENT} (P = would have auto-projected)\n`)
console.log("── without passage context ──────────────────────────────────")
const before = run(false)
console.log("\n── with passage context ─────────────────────────────────────")
const after = run(true)

console.log("\n==============================================================")
console.log(`  right   ${before.right}  ->  ${after.right}`)
console.log(`  wrong   ${before.wrong}  ->  ${after.wrong}`)
console.log(`  missed  ${before.missed}  ->  ${after.missed}`)
console.log(`  noise   ${before.noise}  ->  ${after.noise}   <- must not rise`)
