// A realistic sermon, sentence by sentence, to measure how often EmetAI
// interrupts with a verse nobody asked for.
//
// The curated paraphrase test proves recall. This proves PRECISION, which is
// what actually matters in a service: a preacher speaks for half an hour, so
// even a 2% false-positive rate means the projector changes a dozen times for
// no reason. Target: zero wrong verses.

import { readFileSync } from "node:fs"
import { normalize, type Bible, type Verse } from "../src/data/bible"
import { matchQuote } from "../src/lib/quoteMatch"
import { looksLikeInstruction } from "../src/lib/wakeWord"

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

// Ordinary preaching. None of this is scripture; none of it should fire.
const SERMON_EN = [
  "good morning church and welcome to the house of the lord this morning",
  "i want to thank the worship team for leading us so beautifully today",
  "please turn with me in your bibles and let us stand together",
  "last sunday we began looking at what it means to walk by faith",
  "i remember when i was a young man working in my fathers business",
  "there was a time in my life when i did not know where the money would come from",
  "and i want to tell you this morning that god has never once failed me",
  "many of you are carrying burdens that nobody in this room knows about",
  "you came here today tired and you are wondering if anything will change",
  "the enemy wants you to believe that your situation is permanent",
  "but i have come to tell somebody that your story is not finished",
  "there is a young lady here who has been praying for a very long time",
  "i believe that before this year ends god will answer that prayer",
  "let me say it again because i do not think everybody heard me",
  "we serve a god who is faithful even when we are faithless",
  "somebody give the lord a shout of praise in this place",
  "i am going to close in just a moment but i want to say one more thing",
  "if you are here and you have never given your life to christ",
  "we would love to pray with you at the front after the service",
  "the ushers will come now and receive our offering unto the lord",
  "next week we continue this series and i believe it will bless you",
  "remember that the mid week service starts at six o clock on wednesday",
  "let us pray together as we bring this time of worship to a close",
  "father we thank you for your presence with us here this morning",
  "we ask that you would go before us into this coming week",
]

const SERMON_RW = [
  "muraho neza bavandimwe turishimiye kubona mwese muri hano uyu munsi",
  "ndashaka gushimira itsinda ryaririmbye neza cyane uyu munsi",
  "icyumweru gishize twatangiye kwiga ibyerekeye kugendera mu kwizera",
  "hari umuntu hano uri gutwara umutwaro nta wundi uzi",
  "ndabizi ko imana izakora ikintu gishya mu buzima bwawe",
  "reka dusenge hamwe mbere yuko dusoza iki gihe",
  "abakozi baraza kwakira amaturo yacu ubu",
  "icyumweru gitaha tuzakomeza iri somo kandi ndizera ko rizabaha umugisha",
]

const SERMON_FR = [
  "bonjour a tous et bienvenue dans la maison du seigneur ce matin",
  "je voudrais remercier l equipe de louange pour ce beau moment",
  "la semaine derniere nous avons commence a parler de la foi",
  "il y a quelqu un ici ce matin qui porte un fardeau tres lourd",
  "je crois que dieu va faire quelque chose de nouveau dans ta vie",
  "prions ensemble avant de terminer ce temps de louange",
  "les placiers vont maintenant recevoir notre offrande",
]

// The paraphrases that MUST still be caught, so precision is not bought by
// simply refusing to match anything.
const REAL: [string, string, string][] = [
  ["kjv", "god loved the world so much that he gave his only son so that whoever believes in him will not perish but have everlasting life", "John 3:16"],
  ["kjv", "the lord is my shepherd and so i shall never be in want", "Psalms 23:1"],
  ["kjv", "we know that everything works together for good to those who love god and are called according to his purpose", "Romans 8:28"],
  ["kjv", "i can do all things through christ who keeps strengthening me", "Philippians 4:13"],
  ["kjv", "come to me all of you that labour and are heavy laden and i will give you rest", "Matthew 11:28"],
  ["kjv", "trust in the lord with your whole heart and do not lean on your own understanding", "Proverbs 3:5"],
  ["by", "imana yakunze cyane abari mu isi ku buryo yatanze umwana wayo w ikinege", "Yohana 3:16"],
  ["by", "uwiteka ni umwungeri wanjye sinzakena na hato", "Zaburi 23:1"],
  ["by", "nimuze kuri jye mwese abarushye kandi muremerewe nanjye nzabaruhura", "Matayo 11:28"],
  ["lsg", "dieu a tellement aime le monde qu il a donne son fils unique afin que quiconque croit en lui ne perisse point", "Jean 3:16"],
  ["lsg", "l eternel est mon berger je ne manquerai de rien", "Psaumes 23:1"],
]

const bibles: Record<string, Bible> = {
  kjv: load("kjv"),
  by: load("by"),
  lsg: load("ls1910"),
}

let falsePositives = 0
let confidentFalse = 0
let spoken = 0

function sweep(bibleId: string, lines: string[], label: string) {
  console.log(`\n--- ${label} (${lines.length} sentences of ordinary preaching) ---`)
  for (const line of lines) {
    spoken++
    const m = matchQuote(bibles[bibleId], line)
    if (m) {
      falsePositives++
      if (m.confident) confidentFalse++
      console.log(
        `  ${m.confident ? "PROJECTED" : "offered  "}  ${m.verse.book} ${m.verse.chapter}:${m.verse.verse}` +
        `  (${m.score.toFixed(2)})\n      from: "${line.slice(0, 76)}…"`
      )
    }
  }
}

sweep("kjv", SERMON_EN, "English")
sweep("by", SERMON_RW, "Kinyarwanda")
sweep("lsg", SERMON_FR, "French")

console.log("\n--- real paraphrases must still be found ---")
let found = 0
let confidentFound = 0
for (const [id, said, want] of REAL) {
  const m = matchQuote(bibles[id], said)
  const got = m ? `${m.verse.book} ${m.verse.chapter}:${m.verse.verse}` : "—"
  const ok = got === want
  if (ok) {
    found++
    if (m!.confident) confidentFound++
    console.log(`  ok  ${want}  (${m!.score.toFixed(2)}${m!.confident ? ", projected" : ", offered"})`)
  } else {
    console.log(`FAIL  wanted ${want}, got ${got}`)
  }
}

// ---------------------------------------------------------------------------
// Wake-free listening: with the Emet button on, no name has to be spoken, so
// every sentence is a candidate command. That is only safe if ordinary
// preaching is never mistaken for one — and this corpus is full of imperatives
// aimed at people ("please turn with me in your bibles", "somebody give the
// Lord a shout"), which is exactly what a naive verb check would fire on.
console.log("\n--- wake-free filter: preaching must not read as commands ---")
const allPreaching = [...SERMON_EN, ...SERMON_RW, ...SERMON_FR]
const falseInstructions = allPreaching.filter(looksLikeInstruction)
for (const line of falseInstructions) {
  console.log(`  MISFIRE  "${line.slice(0, 70)}…"`)
}
console.log(`  ${allPreaching.length - falseInstructions.length}/${allPreaching.length} left alone`)

console.log("\n--- wake-free filter: real commands must be recognised ---")
const COMMANDS = [
  "open my account", "next verse", "clear the screen", "show me the clips",
  "go to admin", "who was mao zedong", "what is photosynthesis",
  "switch off listening", "show me verses about faith", "put it in french",
  "tell me about the reformation", "open the display", "go to verse 12",
  // Describing the verse instead of citing it. Spoken in a real service and
  // thrown away by a flat word limit — this is precisely the help the product
  // exists to give, and it is twenty-five words long.
  "theres a verse in jeremiah that talks about how the israelites were " +
    "offering offerings to a queen of heaven can you give me that scripture",
  "what verse says that god so loved the world",
  "can you find me the passage about the prodigal son",
]
const missedCommands = COMMANDS.filter((c) => !looksLikeInstruction(c))
for (const c of missedCommands) console.log(`  MISSED   "${c}"`)
console.log(`  ${COMMANDS.length - missedCommands.length}/${COMMANDS.length} recognised`)

console.log(`\n${"=".repeat(62)}`)
console.log(`  ordinary sentences spoken : ${spoken}`)
console.log(`  preaching misread as command: ${falseInstructions.length}   <- must be 0`)
console.log(`  commands recognised       : ${COMMANDS.length - missedCommands.length}/${COMMANDS.length}`)
console.log(`  wrong verses offered      : ${falsePositives}`)
console.log(`  wrong verses PROJECTED    : ${confidentFalse}   <- must be 0`)
console.log(`  real paraphrases found    : ${found}/${REAL.length}`)
console.log(`  …of those, projected      : ${confidentFound}`)
console.log("=".repeat(62))

const clean =
  confidentFalse === 0 && found === REAL.length && falseInstructions.length === 0
process.exit(clean ? 0 : 1)
