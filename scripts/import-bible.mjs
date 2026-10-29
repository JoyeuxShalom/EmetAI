// Downloads a full Bible from getBible v2 and converts it to EmetAI format.
// Usage:  node scripts/import-bible.mjs kjv
//         node scripts/import-bible.mjs web
//         node scripts/import-bible.mjs ls1910

import { writeFile, mkdir } from "node:fs/promises"

const id = process.argv[2]
if (!id) {
  console.error("Usage: node scripts/import-bible.mjs <translation-id>   (kjv, web, ls1910)")
  process.exit(1)
}

// Cross-language aliases per book number (1–66).
// Kinyarwanda names first, then common English/French short forms.
// All lowercase, no spaces (numbered books written as "1sam" style).
const ALIASES = {
  1: "itangiriro gen genesis genese",
  2: "kuva ex exo exodus exode",
  3: "abalewi lev leviticus levitique",
  4: "kubara num numbers nombres",
  5: "gutegeka deut deuteronomy deuteronome",
  6: "yosuwa jos joshua josue",
  7: "abacamanza judg judges juges",
  8: "rusi ruth rut",
  9: "1samweli 1sam 1samuel",
  10: "2samweli 2sam 2samuel",
  11: "1abami 1kgs 1kings 1rois",
  12: "2abami 2kgs 2kings 2rois",
  13: "1ngoma 1chr 1chronicles 1chroniques",
  14: "2ngoma 2chr 2chronicles 2chroniques",
  15: "ezira ezra esdras",
  16: "nehemiya neh nehemiah nehemie",
  17: "esiteri est esther",
  18: "yobu job",
  19: "zaburi zab ps psalm psalms psaume psaumes",
  20: "imigani prov proverbs proverbes",
  21: "umubwiriza eccl ecclesiastes ecclesiaste",
  22: "indirimbo song cantique cantiques",
  23: "yesaya isa isaiah esaie",
  24: "yeremiya jer jeremiah jeremie",
  25: "amaganya lam lamentations",
  26: "ezekiyeli ezek ezekiel ezechiel",
  27: "daniyeli dan daniel",
  28: "hoseya hos hosea osee",
  29: "yoweli joel",
  30: "amosi amos",
  31: "obadiya obad obadiah abdias",
  32: "yona jonah jonas",
  33: "mika mic micah michee",
  34: "nahumu nah nahum",
  35: "habakuki hab habakkuk habacuc",
  36: "zefaniya zeph zephaniah sophonie",
  37: "hagayi hag haggai aggee",
  38: "zekariya zech zechariah zacharie",
  39: "malaki mal malachi malachie",
  40: "matayo mat mt matthew matthieu",
  41: "mariko mk mark marc",
  42: "luka lk luke luc",
  43: "yohana yoh jn john jean",
  44: "ibyakozwe acts actes",
  45: "abaroma rom romans romains",
  46: "1abakorinto 1cor 1corinthians 1corinthiens",
  47: "2abakorinto 2cor 2corinthians 2corinthiens",
  48: "abagalatiya gal galatians galates",
  49: "abefeso eph ephesians ephesiens",
  50: "abafilipi phil philippians philippiens",
  51: "abakolosayi col colossians colossiens",
  52: "1abatesalonike 1thess 1thessalonians 1thessaloniciens",
  53: "2abatesalonike 2thess 2thessalonians 2thessaloniciens",
  54: "1timoteyo 1tim 1timothy 1timothee",
  55: "2timoteyo 2tim 2timothy 2timothee",
  56: "tito titus tite",
  57: "filemoni phlm philemon",
  58: "abaheburayo heb hebrews hebreux",
  59: "yakobo jas james jacques",
  60: "1petero 1pet 1peter 1pierre",
  61: "2petero 2pet 2peter 2pierre",
  62: "1yohana 1jn 1john 1jean",
  63: "2yohana 2jn 2john 2jean",
  64: "3yohana 3jn 3john 3jean",
  65: "yuda jude",
  66: "ibyahishuwe rev revelation apocalypse",
}

console.log(`Downloading ${id} from getBible…`)
const res = await fetch(`https://api.getbible.net/v2/${id}.json`)
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}. Check the translation id.`)
  process.exit(1)
}
const src = await res.json()

// Be tolerant of small shape differences in the source data.
const rawBooks = src.books ?? src.book
if (!Array.isArray(rawBooks)) {
  console.error("Unexpected data shape: no books array found. First keys:", Object.keys(src))
  process.exit(1)
}

let verseCount = 0
const books = rawBooks.map((b) => {
  const nr = b.nr ?? b.number
  return {
    nr,
    name: (b.name ?? "").trim(),
    aliases: (ALIASES[nr] ?? "").split(" ").filter(Boolean),
    chapters: (b.chapters ?? []).map((c) => ({
      chapter: c.chapter ?? c.nr,
      verses: (c.verses ?? []).map((v) => {
        verseCount++
        return { v: v.verse ?? v.nr, t: String(v.text ?? "").trim() }
      }),
    })),
  }
})

const out = {
  id,
  name: src.translation ?? id,
  language: src.lang ?? "",
  books,
}

await mkdir("public/bibles", { recursive: true })
await writeFile(`public/bibles/${id}.json`, JSON.stringify(out))
console.log(`✔ Wrote public/bibles/${id}.json — ${books.length} books, ${verseCount} verses`)