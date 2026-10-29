// Paraphrase recognition: can EmetAI name the verse a preacher is loosely
// reciting?  Run with:  npx tsx scripts/test-paraphrase.ts
//
// Every "said" line below is deliberately NOT the text of the verse — it is
// how someone actually preaches it, from memory, in their own words.

import { readFileSync } from "node:fs"
import { normalize, type Bible, type Verse } from "../src/data/bible"
import { matchQuote, warmQuoteIndex } from "../src/lib/quoteMatch"

function load(id: string): Bible {
  const file = JSON.parse(readFileSync(`public/bibles/${id}.json`, "utf-8"))
  const verses: Verse[] = []
  file.books.forEach((book: any, i: number) => {
    const bookNr = book.nr ?? i + 1
    for (const ch of book.chapters) {
      for (const row of ch.verses) {
        verses.push({
          bookNr, book: book.name, chapter: ch.chapter, verse: row.v,
          text: row.t, norm: normalize(row.t), translation: file.name,
        })
      }
    }
  })
  return { meta: { id: file.id, name: file.name }, books: file.books, verses }
}

let pass = 0
let fail = 0

function expect(bible: Bible, said: string, want: string, label: string) {
  const started = Date.now()
  const m = matchQuote(bible, said)
  const ms = Date.now() - started
  const got = m ? `${m.verse.book} ${m.verse.chapter}:${m.verse.verse}` : "—"
  const ok = got.toLowerCase() === want.toLowerCase()
  if (ok) {
    pass++
    console.log(`  ok  ${label}`)
    console.log(`      → ${got}  score ${m!.score.toFixed(2)}${m!.confident ? " (confident)" : " (offer)"}  ${ms}ms`)
  } else {
    fail++
    console.log(`FAIL  ${label}`)
    console.log(`      said : ${said}`)
    console.log(`      want : ${want}   got: ${got}${m ? ` (${m.score.toFixed(2)})` : ""}`)
  }
}

function expectNothing(bible: Bible, said: string, label: string) {
  const m = matchQuote(bible, said)
  if (!m) {
    pass++
    console.log(`  ok  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label}`)
    console.log(`      said: ${said}`)
    console.log(`      but matched ${m.verse.book} ${m.verse.chapter}:${m.verse.verse} (${m.score.toFixed(2)})`)
  }
}

// ---------------------------------------------------------------- English --
console.log("\n=== English (KJV) — paraphrased from the pulpit ===")
const kjv = load("kjv")
warmQuoteIndex(kjv)

expect(kjv, "god loved the world so much that he gave his only son so that whoever believes in him will not perish but have everlasting life",
  "John 3:16", "John 3:16 reworded")
expect(kjv, "the lord is my shepherd and so i shall never be in want",
  "Psalms 23:1", "Psalm 23:1 reworded")
expect(kjv, "we know that everything works together for good to those who love god and are called according to his purpose",
  "Romans 8:28", "Romans 8:28 reworded")
expect(kjv, "in the very beginning god created the heaven and also the earth",
  "Genesis 1:1", "Genesis 1:1 padded")
expect(kjv, "i can do all things through christ who keeps strengthening me",
  "Philippians 4:13", "Philippians 4:13 reworded")
expect(kjv, "trust in the lord with your whole heart and do not lean on your own understanding",
  "Proverbs 3:5", "Proverbs 3:5 modernised")
expect(kjv, "come to me all of you that labour and are heavy laden and i will give you rest",
  "Matthew 11:28", "Matthew 11:28 reworded")
expect(kjv, "the thief comes only to steal and to kill and to destroy but i came so they may have life",
  "John 10:10", "John 10:10 modernised")

// -------------------------------------------------------------- Kinyarwanda
console.log("\n=== Kinyarwanda (Bibiliya Yera) — paraphrased ===")
const by = load("by")
warmQuoteIndex(by)

expect(by, "imana yakunze cyane abari mu isi ku buryo yatanze umwana wayo w ikinege",
  "Yohana 3:16", "Yohana 3:16 reworded")
expect(by, "uwiteka ni umwungeri wanjye sinzakena na hato",
  "Zaburi 23:1", "Zaburi 23:1 reworded")
expect(by, "mbere na mbere imana yaremye ijuru n isi",
  "Itangiriro 1:1", "Itangiriro 1:1")
expect(by, "nshobora byose kubera uwo umpa imbaraga ari we kristo",
  "Abafilipi 4:13", "Abafilipi 4:13 reworded")
expect(by, "nimuze kuri jye mwese abarushye kandi muremerewe nanjye nzabaruhura",
  "Matayo 11:28", "Matayo 11:28 reworded")

// ------------------------------------------------------------------ French --
console.log("\n=== French (Louis Segond) — paraphrased ===")
const lsg = load("ls1910")
warmQuoteIndex(lsg)

expect(lsg, "dieu a tellement aime le monde qu il a donne son fils unique afin que quiconque croit en lui ne perisse point",
  "Jean 3:16", "Jean 3:16 reworded")
expect(lsg, "l eternel est mon berger je ne manquerai de rien",
  "Psaumes 23:1", "Psaumes 23:1")
expect(lsg, "au commencement dieu crea les cieux et la terre",
  "Genèse 1:1", "Genèse 1:1")
expect(lsg, "je puis tout par celui qui me fortifie",
  "Philippiens 4:13", "Philippiens 4:13")

// ----------------------------------------------------- must NOT fire -------
console.log("\n=== ordinary preaching must NOT trigger a verse ===")
expectNothing(kjv, "good morning church it is wonderful to see all of you here this morning",
  "a greeting")
expectNothing(kjv, "please turn with me and let us all stand together as we pray",
  "an instruction")
expectNothing(kjv, "last week we talked about the importance of coming together on sunday",
  "a recap")
expectNothing(by, "muraho neza bavandimwe turishimiye kubona mwese muri hano",
  "a Kinyarwanda greeting")
expectNothing(lsg, "bonjour a tous nous sommes heureux de vous accueillir aujourd hui",
  "a French greeting")

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
