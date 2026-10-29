// Tradition-forgiving reference resolution.
//
// Preachers quote references from whichever Bible they grew up with:
// "Joel 2:28" (KJV/English numbering) and "Joweli 3:1" (Kinyarwanda/French
// numbering) are the SAME verse. When the reference as spoken doesn't exist
// in the primary Bible, re-interpret it through the other tradition instead
// of giving up.

import {
  applyOverrides,
  getVerse,
  reverseOverrides,
  type Bible,
  type Mappings,
  type Overrides,
  type Ref,
  type Verse,
} from "../data/bible"

/** Find a verse in a LOCAL primary Bible, forgiving about versification. */
export function findVerseFlexible(
  bible: Bible,
  primaryId: string,
  bookNr: number,
  chapter: number,
  verse: number,
  mappings: Mappings,
  overrides: Overrides
): Verse | null {
  // 1) Exactly as spoken, in the primary Bible's own numbering.
  const direct = getVerse(bible, bookNr, chapter, verse)
  if (direct) return direct

  // 2) Spoken in KJV numbering while the primary follows the French/Hebrew
  //    tradition (e.g. "Joel 2:28" -> Bibiliya Yera "Yoweli 3:1").
  const own = applyOverrides(overrides[primaryId], bookNr, chapter, verse)
  if (own) {
    const v = getVerse(bible, own.bookNr, own.chapter, own.verse)
    if (v) return v
  }
  const delta = mappings[primaryId]?.[`${bookNr}:${chapter}`]
  if (delta !== undefined) {
    const v = getVerse(bible, bookNr, chapter, verse + delta)
    if (v) return v
  }

  // 3) Spoken in French numbering while the primary follows KJV numbering
  //    (e.g. "Joël 4:1" -> KJV "Joel 3:1").
  const frenchRules = overrides["by"] ?? overrides["ls1910"]
  if (!overrides[primaryId] && frenchRules) {
    const rev = reverseOverrides(frenchRules, bookNr, chapter, verse)
    if (rev) {
      const v = getVerse(bible, rev.bookNr, rev.chapter, rev.verse)
      if (v) return v
    }
  }
  return null
}

/** Ordered candidate refs for an ONLINE primary (fetch one by one until a hit).
 *  First the reference as spoken, then its other-tradition interpretation. */
export function candidateRefs(
  primaryTradition: "kjv" | "french",
  bookNr: number,
  chapter: number,
  verse: number,
  overrides: Overrides
): Ref[] {
  const spoken: Ref = { bookNr, chapter, verse }
  const frenchRules = overrides["by"] ?? overrides["ls1910"]
  const out: Ref[] = [spoken]
  if (!frenchRules) return out

  if (primaryTradition === "french") {
    // Maybe the speaker used KJV numbering — convert KJV -> French.
    const o = applyOverrides(frenchRules, bookNr, chapter, verse)
    if (o) out.push(o)
  } else {
    // Maybe the speaker used French numbering — convert French -> KJV.
    const rev = reverseOverrides(frenchRules, bookNr, chapter, verse)
    if (rev) out.push(rev)
  }
  return out
}
