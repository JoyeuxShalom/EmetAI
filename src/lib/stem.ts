// Light multilingual stemming, so a paraphrase matches the verse it came from.
//
// A preacher never repeats a verse word-for-word. They say "God loved the
// world so much" where the KJV says "God so loved the world"; they say
// "Imana ikunda" where the Bible says "Imana yakunze". The words are the same
// word — only the ending, or in Kinyarwanda the beginning, has moved.
//
// Two keys are derived from every token:
//   head — the word with its ending trimmed  (English, French: loved/loveth → lov)
//   tail — the word with its beginning trimmed (Kinyarwanda: yakunze/tuzakunda → kunz…)
//
// Neither is linguistically perfect. They don't need to be: they only widen
// the net, and a match still has to survive idf-weighted scoring afterwards.

const MIN_STEM = 4

// Longest first — "ations" must be tried before "s".
const ENGLISH_SUFFIXES = [
  "ationally", "ization", "ations", "ingly", "eth", "est", "edly",
  "ation", "ings", "ies", "ied", "ily", "ing", "ers", "est", "ed", "es",
  "ly", "er", "s",
]

const FRENCH_SUFFIXES = [
  "eraient", "erions", "assent", "aient", "erait", "erons", "eront",
  "ement", "ions", "iez", "ais", "ait", "ant", "ent", "ons", "ez",
  "er", "ir", "ee", "es", "e", "s",
]

/** Trim a word's ending. Latin languages inflect here. */
export function head(token: string): string {
  if (token.length <= MIN_STEM) return token
  for (const suffix of ENGLISH_SUFFIXES) {
    if (token.length - suffix.length >= MIN_STEM && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  for (const suffix of FRENCH_SUFFIXES) {
    if (token.length - suffix.length >= MIN_STEM && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

// Kinyarwanda glues meaning onto the FRONT: noun-class prefixes (umu-, aba-,
// iki-, ama-, ubu-…) and verb subject/tense prefixes (ya-, ba-, tu-, ra-, za-).
// Stripping a fixed list is unreliable, so the tail is taken instead — whatever
// prefix is attached, the root survives at the end.
const RW_PREFIXES = [
  "abaa", "amaa", "ibii", "ubwa",
  "umu", "umw", "aba", "abo", "iki", "icy", "ibi", "iby", "ama", "ubu", "ubw",
  "uku", "ukw", "aka", "aga", "utu", "udu", "iri", "iry", "ini", "iny", "imi",
  "ins", "inz", "ing", "ent",
  "ya", "za", "ba", "bi", "tu", "mu", "ku", "ni", "na", "ra", "ri", "ru", "ha",
  "a", "i", "u", "e", "o",
]

/** Trim a word's beginning. Bantu languages inflect here. */
export function tail(token: string): string {
  if (token.length <= MIN_STEM) return token
  for (const prefix of RW_PREFIXES) {
    if (token.length - prefix.length >= MIN_STEM && token.startsWith(prefix)) {
      return token.slice(prefix.length)
    }
  }
  return token
}

/** Every lookup key a token should be findable under. */
export function keysFor(token: string): string[] {
  if (!token) return []
  const keys = new Set<string>([token])
  const h = head(token)
  if (h !== token && h.length >= MIN_STEM) keys.add(h)
  const t = tail(token)
  if (t !== token && t.length >= MIN_STEM) keys.add(t)
  // A word inflected at both ends (Kinyarwanda verbs regularly are).
  const both = head(t)
  if (both !== t && both.length >= MIN_STEM) keys.add(both)
  return Array.from(keys)
}
