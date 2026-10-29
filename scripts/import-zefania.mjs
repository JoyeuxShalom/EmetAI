// Converts a Zefania XML Bible into EmetAI format.
// Usage:  node scripts/import-zefania.mjs <file.xml> <id>
//         node scripts/import-zefania.mjs --selftest
//
// ⚠️ Only run this on Bible files you have PERMISSION to use.

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { XMLParser } from "fast-xml-parser"

// Same trilingual aliases as import-bible.mjs, keyed by book number 1–66.
const ALIASES = {
  1: "itangiriro gen genesis genese", 2: "kuva ex exo exodus exode",
  3: "abalewi lev leviticus levitique", 4: "kubara num numbers nombres",
  5: "gutegeka deut deuteronomy deuteronome", 6: "yosuwa jos joshua josue",
  7: "abacamanza judg judges juges", 8: "rusi ruth rut",
  9: "1samweli 1sam 1samuel", 10: "2samweli 2sam 2samuel",
  11: "1abami 1kgs 1kings 1rois", 12: "2abami 2kgs 2kings 2rois",
  13: "1ngoma 1chr 1chronicles 1chroniques", 14: "2ngoma 2chr 2chronicles 2chroniques",
  15: "ezira ezra esdras", 16: "nehemiya neh nehemiah nehemie",
  17: "esiteri est esther", 18: "yobu job",
  19: "zaburi zab ps psalm psalms psaume psaumes", 20: "imigani prov proverbs proverbes",
  21: "umubwiriza eccl ecclesiastes ecclesiaste", 22: "indirimbo song cantique cantiques",
  23: "yesaya isa isaiah esaie", 24: "yeremiya jer jeremiah jeremie",
  25: "amaganya lam lamentations", 26: "ezekiyeli ezek ezekiel ezechiel",
  27: "daniyeli dan daniel", 28: "hoseya hos hosea osee",
  29: "yoweli joel", 30: "amosi amos", 31: "obadiya obad obadiah abdias",
  32: "yona jonah jonas", 33: "mika mic micah michee", 34: "nahumu nah nahum",
  35: "habakuki hab habakkuk habacuc", 36: "zefaniya zeph zephaniah sophonie",
  37: "hagayi hag haggai aggee", 38: "zekariya zech zechariah zacharie",
  39: "malaki mal malachi malachie", 40: "matayo mat mt matthew matthieu",
  41: "mariko mk mark marc", 42: "luka lk luke luc", 43: "yohana yoh jn john jean",
  44: "ibyakozwe acts actes", 45: "abaroma rom romans romains",
  46: "1abakorinto 1cor 1corinthians 1corinthiens", 47: "2abakorinto 2cor 2corinthians 2corinthiens",
  48: "abagalatiya gal galatians galates", 49: "abefeso eph ephesians ephesiens",
  50: "abafilipi phil philippians philippiens", 51: "abakolosayi col colossians colossiens",
  52: "1abatesalonike 1thess 1thessalonians 1thessaloniciens",
  53: "2abatesalonike 2thess 2thessalonians 2thessaloniciens",
  54: "1timoteyo 1tim 1timothy 1timothee", 55: "2timoteyo 2tim 2timothy 2timothee",
  56: "tito titus tite", 57: "filemoni phlm philemon", 58: "abaheburayo heb hebrews hebreux",
  59: "yakobo jas james jacques", 60: "1petero 1pet 1peter 1pierre",
  61: "2petero 2pet 2peter 2pierre", 62: "1yohana 1jn 1john 1jean",
  63: "2yohana 2jn 2john 2jean", 64: "3yohana 3jn 3john 3jean",
  65: "yuda jude", 66: "ibyahishuwe rev revelation apocalypse",
}

const SELFTEST_XML = `<?xml version="1.0" encoding="utf-8"?>
<XMLBIBLE biblename="SelfTest Bible">
  <BIBLEBOOK bnumber="43" bname="Yohana">
    <CHAPTER cnumber="3">
      <VERS vnumber="16">Test verse one.</VERS>
      <VERS vnumber="17">Test verse two.</VERS>
    </CHAPTER>
  </BIBLEBOOK>
  <BIBLEBOOK bnumber="19" bname="Zaburi">
    <CHAPTER cnumber="23">
      <VERS vnumber="1">Test psalm.</VERS>
    </CHAPTER>
  </BIBLEBOOK>
</XMLBIBLE>`

function asArray(x) {
  return x === undefined ? [] : Array.isArray(x) ? x : [x]
}

const selftest = process.argv[2] === "--selftest"
const [file, id] = selftest ? [null, "selftest"] : [process.argv[2], process.argv[3]]

if (!selftest && (!file || !id)) {
  console.error("Usage: node scripts/import-zefania.mjs <file.xml> <id>")
  console.error("       node scripts/import-zefania.mjs --selftest")
  process.exit(1)
}

const xml = selftest ? SELFTEST_XML : await readFile(file, "utf8")

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
})
const doc = parser.parse(xml)

const root = doc.XMLBIBLE ?? doc.xmlbible
if (!root) {
  console.error("Not a Zefania XML file (no <XMLBIBLE> root). Found:", Object.keys(doc))
  process.exit(1)
}

let verseCount = 0
const books = asArray(root.BIBLEBOOK).map((b) => {
  const nr = parseInt(b["@_bnumber"])
  return {
    nr,
    name: String(b["@_bname"] ?? `Book ${nr}`).trim(),
    aliases: (ALIASES[nr] ?? "").split(" ").filter(Boolean),
    chapters: asArray(b.CHAPTER).map((c) => ({
      chapter: parseInt(c["@_cnumber"]),
      verses: asArray(c.VERS).map((v) => {
        verseCount++
        const text = typeof v === "object" ? (v["#text"] ?? "") : v
        return { v: parseInt(v["@_vnumber"] ?? 0) || 0, t: String(text).trim() }
      }),
    })),
  }
})

const out = {
  id,
  name: String(root["@_biblename"] ?? id).trim(),
  language: "rw",
  books,
}

await mkdir("public/bibles", { recursive: true })
await writeFile(`public/bibles/${id}.json`, JSON.stringify(out))
console.log(`✔ Wrote public/bibles/${id}.json — ${books.length} books, ${verseCount} verses`)
if (selftest) {
  console.log("Self-test complete. You can delete public/bibles/selftest.json.")
}