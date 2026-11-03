// The names in the chapter the service is reading, for the ear to expect.
//
// Recognition is a search over what is plausible, and a name the model has
// never met is not in that search until something puts it there. That is why
// "Bowazi", "Nawomi" and "Elimeleki" come back as noise while "Yohana" — one
// of the 207 book names the church's standing vocabulary already carries —
// comes back right.
//
// This finds the people and places in the chapter actually open, so the ear
// is told about them for exactly as long as they matter.
//
// NAMES ONLY, deliberately. Handing a transcriber the sentences it is about
// to hear invites it to hand them straight back whether or not they were
// spoken, and invented scripture on a wall is a far worse failure than a
// misspelt name.

import type { Bible } from "../data/bible"

/** Words that begin a sentence are capitalised for grammar, not because they
 *  are names, so the first word after a full stop is never counted. */
const ENDS_SENTENCE = /[.!?:;»”"']$/

/** Long enough to be worth hinting and short enough to be one word. */
const MIN_NAME = 3
const MAX_NAME = 24

/** Beyond this the hint stops being a hint and starts being an instruction
 *  the model has to read past on every utterance.
 *
 *  Kept deliberately short. The list is ranked by how often a word repeats
 *  WITHIN the chapter, and a person in the story is named again and again
 *  while a rare verb form appears once — so the real names rise to the top
 *  and a short list is mostly names even in a chapter that has few. On
 *  Ruth 4 the first eight are Bowazi, Nawomi, Rusi, Yesayi, Elimeleki,
 *  Mahaloni, Nahashoni, Obedi. */
const MAX_NAMES = 12

/** A name appears in a handful of verses; an ordinary word appears
 *  everywhere. Capitalisation alone cannot tell them apart, because
 *  Kinyarwanda capitalises the first word inside a quotation too — which is
 *  why a first pass over Imigani 8 returned "Kandi", "Kuko" and "Mfite" as
 *  names. Rarity can tell them apart, and it needs no word list. */
const NAME_MAX_SHARE = 0.0015

/** Verses containing each word, counted once per Bible and kept. */
const frequency = new WeakMap<Bible, Map<string, number>>()

function verseCounts(bible: Bible): Map<string, number> {
  let counts = frequency.get(bible)
  if (counts) return counts
  counts = new Map<string, number>()
  for (const v of bible.verses) {
    const seen = new Set(v.norm.split(" "))
    for (const w of seen) if (w) counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  frequency.set(bible, counts)
  return counts
}

export function namesInChapter(
  bible: Bible,
  bookNr: number,
  chapter: number,
  limit = MAX_NAMES
): string {
  const counts = new Map<string, number>()
  const everywhere = verseCounts(bible)
  const rareEnough = bible.verses.length * NAME_MAX_SHARE

  for (const v of bible.verses) {
    if (v.bookNr !== bookNr || v.chapter !== chapter) continue
    const words = v.text.split(/\s+/)
    words.forEach((raw, i) => {
      // Strip punctuation but keep the apostrophes Kinyarwanda names carry.
      const word = raw.replace(/^[^\p{L}']+/gu, "").replace(/[^\p{L}']+$/gu, "")
      if (word.length < MIN_NAME || word.length > MAX_NAME) return
      if (!/^\p{Lu}/u.test(word)) return
      if (i === 0 || ENDS_SENTENCE.test(words[i - 1] ?? "")) return
      // Common across the whole Bible? Then it is a word, not a name.
      const lower = word.toLowerCase().replace(/[^\p{L}']/gu, "")
      if ((everywhere.get(lower) ?? 0) > rareEnough) return
      counts.set(word, (counts.get(word) ?? 0) + 1)
    })
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word)
    .join(", ")
}
