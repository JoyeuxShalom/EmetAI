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

/** Warm the index in the background so the first quote of the service isn't slow. */
export function warmQuoteIndex(bible: Bible) {
  setTimeout(() => getIndex(bible), 0)
}
