// Quote detection: recognizes WHICH verse the preacher is reciting — even
// heavily paraphrased, even without a reference, offline, in any language.
//
// Method: an inverted index (token -> verses) with idf weighting, built over
// both the literal words and their stems. A spoken sentence matches a verse
// when its *distinctive* vocabulary lands there, so word order, inflection and
// rewording don't matter — which is exactly what a paraphrase changes.
//
// Scoring deliberately favours precision over coverage. A preacher who
// compresses a long verse into one line shares only a fraction of its words,
// but nearly everything they said belongs to it. Judging that by coverage
// would throw away the very case this exists for.

import { normalize, type Bible, type Verse } from "../data/bible"
import { keysFor } from "./stem"

type Index = {
  idf: Map<string, number>
  postings: Map<string, number[]>   // key -> verse indices
  verseIdfSum: number[]             // per verse: total idf mass
  verseKeys: Set<string>[]          // per verse: every key it can be found by
  verses: Verse[]
}

// A word this distinctive appears in well under ~3% of verses.
const RARE_IDF = 4.5

// Ordinary speech and scripture share plenty of mid-frequency words: a French
// greeting once "matched" Deuteronomy 5:3 on nous/sommes/tous/aujourd'hui
// alone. Real recitation proves itself one of two ways, and both are needed —
// the famous verses fail one or the other.
//
//   a scripture-specific word   "sinzakena" 10.7, "abarushye" 10.2
//   or sheer weight of overlap   John 3:16 shares 19 words worth 76 idf, yet
//                                its wording is so plain that nothing in it
//                                reaches the bar above
const DISTINCTIVE_IDF = 7.5
const MASS_IDF = 40
const MASS_COUNT = 8

// Above this, act without hesitation. Below it but above the caller's
// threshold, offer the verse instead of forcing it on the congregation.
export const CONFIDENT = 0.62

// How many of the spoken words must appear CONSECUTIVELY in the verse before
// a middling score is believed.
//
// Measured on a real 86-minute service: 20 of 229 lines produced a verse and
// exactly one was right. The scoring is bag-of-words, so a sentence sharing
// scattered common words with a verse scores the same as a genuine quote —
// "What have you done that has failed?" landed on Ezekiel 12:22 at 47%, while
// "Go and be as wise as serpents" landed on Matthew 10:16 at 48%. The score
// cannot tell them apart. Word ORDER can: a real quote carries a run of the
// verse's own words in the verse's own order.
// Two, not three, and it is Kinyarwanda that decides that. The language
// agglutinates, so the word boundaries themselves move when a verse is
// reworded — "uwiteka ni WE MWUNGERI wanjye" against "uwiteka ni UMWUNGERI
// wanjye" is the same clause carrying a different number of words. A run of
// three consecutive words is close to unreachable here even in near-verbatim
// recitation. Measured on the five known-good matches and the four known-bad:
//
//   genuine  Psalm 23:1 run 2   Phil 4:13 run 2   Matt 11:28 run 2
//            John 3:16  run 4   Matt 10:16 run 3
//   false    all four           run 0
//
// The gap is between 0 and 2, not between 2 and 3.
const MIN_QUOTE_RUN = 2
// A paraphrase genuinely may share no run at all — "catches paraphrased
// verses" is a feature, not an accident — so a scattered match is not
// refused, only held to a much higher bar.
const SCATTERED_SCORE = 0.58

const indexCache = new Map<string, Index>()

function buildIndex(bible: Bible): Index {
  const docs = bible.verses.map((v) => v.norm.split(" ").filter(Boolean))

  // Document frequency over literal words — idf must reflect real usage, not
  // the inflated counts that stems would produce.
  const df = new Map<string, number>()
  for (const d of docs) {
    for (const w of Array.from(new Set(d))) df.set(w, (df.get(w) ?? 0) + 1)
  }
  const n = docs.length
  const idf = new Map<string, number>()
  df.forEach((c, w) => idf.set(w, Math.log((n + 1) / (c + 1)) + 1))

  const postings = new Map<string, number[]>()
  const verseIdfSum: number[] = []
  const verseKeys: Set<string>[] = []

  docs.forEach((tokens, vi) => {
    let sum = 0
    const keys = new Set<string>()
    for (const w of Array.from(new Set(tokens))) {
      sum += idf.get(w) ?? 1
      for (const key of keysFor(w)) keys.add(key)
    }
    for (const key of keys) {
      let list = postings.get(key)
      if (!list) {
        list = []
        postings.set(key, list)
      }
      list.push(vi)
    }
    verseIdfSum.push(sum)
    verseKeys.push(keys)
  })

  return { idf, postings, verseIdfSum, verseKeys, verses: bible.verses }
}

function getIndex(bible: Bible): Index {
  const key = bible.meta.id
  let idx = indexCache.get(key)
  if (!idx) {
    idx = buildIndex(bible)
    indexCache.set(key, idx)
  }
  return idx
}

export type QuoteMatch = {
  verse: Verse
  score: number
  /** How far ahead of the runner-up this verse is (1 = nothing else came close). */
  margin: number
  /** Strong AND unambiguous — safe to act on without asking. */
  confident: boolean
}

// Scripture repeats itself: "the Lord is my shepherd" resembles a dozen other
// psalms. When the best two candidates are neck and neck we genuinely do not
// know which one is being recited, and guessing puts the wrong verse in front
// of a congregation. Being sure means being clearly ahead.
const REQUIRED_MARGIN = 1.14

type QueryWord = { keys: string[]; idf: number }

/** Build the query's distinctive vocabulary, each word with every key it may
 *  be found under and the idf of its best-known form. */
function queryVocabulary(idx: Index, tokens: string[]): QueryWord[] {
  const seen = new Set<string>()
  const out: QueryWord[] = []
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    const keys = keysFor(token)
    // An unseen word still counts: the stem may match even when the exact
    // inflection never appears in this translation.
    let best = idx.idf.get(token) ?? 0
    if (!best) {
      for (const k of keys) {
        const v = idx.idf.get(k)
        if (v && v > best) best = v
      }
    }
    if (best > 0) out.push({ keys, idf: best })
  }
  return out
}

/** Match a spoken utterance against the Bible's verses.
 *  `threshold` is the floor for offering a verse at all; a match at or above
 *  CONFIDENT is safe to project immediately. */
export function matchQuote(
  bible: Bible,
  utterance: string,
  threshold = 0.42
): QuoteMatch | null {
  // The last ~34 words: a verse is rarely longer, and earlier words belong to
  // the sentence before it.
  const allTokens = normalize(utterance).split(" ").filter(Boolean)
  const tokens = allTokens.slice(-34)
  if (tokens.length < 4) return null

  const idx = getIndex(bible)
  const queryWords = queryVocabulary(idx, tokens)
  if (queryWords.length < 3) return null
  const queryIdfSum = queryWords.reduce((s, x) => s + x.idf, 0)

  // Pass 1 — distinctive words nominate candidates. Common words are skipped
  // entirely; they would nominate half the Bible and cost the time we don't
  // have mid-sermon.
  const candidates = new Set<number>()
  for (const { keys, idf } of queryWords) {
    if (idf < 2.5) continue
    for (const key of keys) {
      const posting = idx.postings.get(key)
      if (posting && posting.length <= 2500) {
        for (const vi of posting) candidates.add(vi)
      }
    }
  }
  if (candidates.size === 0) return null

  // Pass 2 — score each candidate against the whole query vocabulary, keeping
  // the runner-up so we can tell a clear winner from a coin toss.
  let bestVi = -1
  let bestScore = 0
  let runnerUp = 0
  candidates.forEach((vi) => {
    const keys = idx.verseKeys[vi]
    let idfSum = 0
    let count = 0
    let rare = 0
    let strongest = 0
    for (const { keys: qKeys, idf } of queryWords) {
      if (!qKeys.some((k) => keys.has(k))) continue
      idfSum += idf
      count += 1
      if (idf >= RARE_IDF) rare += 1
      if (idf > strongest) strongest = idf
    }
    // Evidence gate. Kinyarwanda verses can be six words long, so a low count
    // is not itself disqualifying — but the words shared must be telling.
    if (count < 3 || rare < 2) return
    const scriptureWord = strongest >= DISTINCTIVE_IDF
    const overwhelming = idfSum >= MASS_IDF && count >= MASS_COUNT
    if (!scriptureWord && !overwhelming) return

    const precision = idfSum / queryIdfSum          // of what was said, how much is in this verse
    const coverage = idfSum / idx.verseIdfSum[vi]   // of this verse, how much was said
    // Weighted geometric mean. Precision dominates so a compressed paraphrase
    // still wins, while coverage stops a single rare word carrying a match.
    const score = Math.pow(precision, 0.68) * Math.pow(coverage, 0.32)

    if (score < threshold) return
    if (score > bestScore) {
      runnerUp = bestScore
      bestScore = score
      bestVi = vi
    } else if (score > runnerUp) {
      runnerUp = score
    }
  })

  if (bestVi < 0) return null

  // Does the winner carry a run of the verse's words, in the verse's order?
  // Only the winner is checked, so this costs one pass over one verse.
  if (bestScore < SCATTERED_SCORE
      && longestRun(tokens, idx.verses[bestVi].norm) < MIN_QUOTE_RUN) {
    return null
  }

  const margin = runnerUp > 0 ? bestScore / runnerUp : Infinity
  return {
    verse: idx.verses[bestVi],
    score: bestScore,
    margin,
    // Sure means both strong AND unrivalled. A verse that only just beat
    // another is a guess, and a guess belongs in Preview, not on the wall.
    confident: bestScore >= CONFIDENT && margin >= REQUIRED_MARGIN,
  }
}

/** The longest stretch of spoken words that appears, in order and unbroken,
 *  inside the verse — compared by STEM, the same way the index matches, so an
 *  inflected retelling still counts. Comparing literal spelling instead finds
 *  nothing: "nshobozwa byose" and "nshobora byose" are the same phrase.
 *
 *  Only ever called on the winning verse, so this costs one short pass. */
function longestRun(tokens: string[], verseNorm: string): number {
  const verseKeys = verseNorm
    .split(" ")
    .filter(Boolean)
    .map((w) => new Set(keysFor(w)))
  const queryKeys = tokens.map((w) => keysFor(w))

  let best = 0
  for (let i = 0; i < queryKeys.length; i++) {
    for (let j = 0; j < verseKeys.length; j++) {
      let run = 0
      while (
        i + run < queryKeys.length &&
        j + run < verseKeys.length &&
        queryKeys[i + run].some((k) => verseKeys[j + run].has(k))
      ) {
        run += 1
      }
      if (run > best) best = run
      if (best >= MIN_QUOTE_RUN) return best   // enough; stop looking
    }
  }
  return best
}

/** Warm the index in the background so the first quote of the service isn't slow. */
export function warmQuoteIndex(bible: Bible) {
  setTimeout(() => getIndex(bible), 0)
}
