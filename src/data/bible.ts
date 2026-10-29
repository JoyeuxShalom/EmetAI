// ---- Types describing the Bible file format ----

export type VerseRow = { v: number; t: string }
export type Chapter = { chapter: number; verses: VerseRow[] }
export type Book = { nr?: number; name: string; aliases: string[]; chapters: Chapter[] }

export type BibleFile = {
  id: string
  name: string
  language: string
  books: Book[]
}

// ---- The shape the rest of the app uses ----

export type Verse = {
  bookNr: number
  book: string
  chapter: number
  verse: number
  text: string
  norm: string
  translation: string
}

export function refOf(v: Verse): string {
  return `${v.book} ${v.chapter}:${v.verse}`
}

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// ---- Loaded Bible with a flat index for fast search ----

export type Bible = {
  meta: { id: string; name: string }
  books: Book[]
  verses: Verse[]
}

export type BibleVersion = {
  id: string
  label: string
  short: string
  source: "local" | "youversion"
  yvId?: number // only for source: "youversion"
  tradition?: "kjv" | "french" // numbering tradition (online versions only)
}

export const VERSIONS: BibleVersion[] = [
  // ---- Offline: always available ----
  { id: "by", label: "Bibiliya Yera", short: "BY", source: "local" },
  { id: "kjv", label: "King James Version", short: "KJV", source: "local" },
  { id: "web", label: "World English Bible", short: "WEB", source: "local" },
  { id: "asv", label: "American Standard Version", short: "ASV", source: "local" },
  { id: "basicenglish", label: "Bible in Basic English", short: "BBE", source: "local" },
  { id: "ls1910", label: "Louis Segond 1910", short: "LSG", source: "local" },
  { id: "martin", label: "Martin 1744", short: "MAR", source: "local" },

  // ---- Online: via YouVersion Platform ----
  { id: "yv-niv", label: "New International Version 2011", short: "NIV", source: "youversion", yvId: 111, tradition: "kjv" },
  { id: "yv-bds", label: "La Bible du Semeur", short: "BDS", source: "youversion", yvId: 21, tradition: "french" },
]

export async function loadBible(version: BibleVersion): Promise<Bible> {
  if (version.source === "youversion") {
    throw new Error("Online versions are fetched per-verse, not preloaded.")
  }
  const res = await fetch(`/bibles/${version.id}.json`)
  if (!res.ok) throw new Error(`Could not load Bible "${version.id}" (${res.status})`)
  const file = (await res.json()) as BibleFile

  const verses: Verse[] = []
  file.books.forEach((book, i) => {
    const bookNr = book.nr ?? i + 1
    for (const ch of book.chapters) {
      for (const row of ch.verses) {
        verses.push({
          bookNr,
          book: book.name,
          chapter: ch.chapter,
          verse: row.v,
          text: row.t,
          norm: normalize(row.t),
          translation: file.name,
        })
      }
    }
  })

  return { meta: { id: file.id, name: file.name }, books: file.books, verses }
}

// ---- Versification mappings (offsets vs KJV numbering) ----

export type Mappings = Record<string, Record<string, number>>

export async function loadMappings(): Promise<Mappings> {
  try {
    const res = await fetch("/bibles/mappings.json")
    if (!res.ok) return {}
    return (await res.json()) as Mappings
  } catch {
    return {}
  }
}

export function getVerse(
  bible: Bible,
  bookNr: number,
  chapter: number,
  verse: number
): Verse | null {
  return (
    bible.verses.find(
      (v) => v.bookNr === bookNr && v.chapter === chapter && v.verse === verse
    ) ?? null
  )
}

// ---- Versification overrides (structural differences) ----

export type OverrideRule = { kjv: string; to: string; verseDelta?: number }
export type Overrides = Record<string, OverrideRule[]> // versionId -> rules

export async function loadOverrides(): Promise<Overrides> {
  try {
    const res = await fetch("/bibles/overrides.json")
    if (!res.ok) return {}
    const file = await res.json()
    const out: Overrides = {}
    for (const key of Object.keys(file.traditions ?? {})) {
      const t = file.traditions[key]
      for (const id of t.appliesTo ?? []) out[id] = t.rules ?? []
    }
    return out
  } catch {
    return {}
  }
}

export type Ref = { bookNr: number; chapter: number; verse: number }

/** KJV-numbered ref -> this version's ref. Null if no rule matches. */
export function applyOverrides(
  rules: OverrideRule[] | undefined,
  bookNr: number,
  chapter: number,
  verse: number
): Ref | null {
  if (!rules) return null
  // Exact verse rule first (e.g. "32:1:17" -> "32:2:1")
  for (const r of rules) {
    const parts = r.kjv.split(":").map(Number)
    if (parts.length === 3 && parts[0] === bookNr && parts[1] === chapter && parts[2] === verse) {
      const [tb, tc, tv] = r.to.split(":").map(Number)
      return { bookNr: tb, chapter: tc, verse: tv }
    }
  }
  // Whole-chapter rule (e.g. "29:3" -> "29:4" with optional verseDelta)
  for (const r of rules) {
    const parts = r.kjv.split(":").map(Number)
    if (parts.length === 2 && parts[0] === bookNr && parts[1] === chapter) {
      const [tb, tc] = r.to.split(":").map(Number)
      return { bookNr: tb, chapter: tc, verse: verse + (r.verseDelta ?? 0) }
    }
  }
  return null
}

/** This version's ref -> KJV-numbered ref (the reverse direction). Null if no rule matches. */
export function reverseOverrides(
  rules: OverrideRule[] | undefined,
  bookNr: number,
  chapter: number,
  verse: number
): Ref | null {
  if (!rules) return null
  // Exact rule whose TARGET matches (e.g. "32:2:1" came from KJV "32:1:17")
  for (const r of rules) {
    const parts = r.to.split(":").map(Number)
    if (parts.length === 3 && parts[0] === bookNr && parts[1] === chapter && parts[2] === verse) {
      const kjvParts = r.kjv.split(":").map(Number)
      if (kjvParts.length === 3) {
        return { bookNr: kjvParts[0], chapter: kjvParts[1], verse: kjvParts[2] }
      }
    }
  }
  // Whole-chapter rule whose TARGET chapter matches (undo the verseDelta)
  for (const r of rules) {
    const toParts = r.to.split(":").map(Number)
    const kjvParts = r.kjv.split(":").map(Number)
    if (
      toParts.length === 2 &&
      kjvParts.length === 2 &&
      toParts[0] === bookNr &&
      toParts[1] === chapter
    ) {
      return { bookNr: kjvParts[0], chapter: kjvParts[1], verse: verse - (r.verseDelta ?? 0) }
    }
  }
  return null
}

/** Find the verse in `to` that corresponds to `v` from version `fromId`. */
export function resolveParallel(
  v: Verse,
  fromId: string,
  to: Bible,
  mappings: Mappings,
  overrides: Overrides
): Verse | null {
  // Step 1: express the source verse in KJV numbering.
  // Structural overrides first (they may move across chapters), then deltas.
  let kjv: Ref
  const rev = reverseOverrides(overrides[fromId], v.bookNr, v.chapter, v.verse)
  if (rev) {
    kjv = rev
  } else {
    kjv = {
      bookNr: v.bookNr,
      chapter: v.chapter,
      verse: v.verse - (mappings[fromId]?.[`${v.bookNr}:${v.chapter}`] ?? 0),
    }
  }

  // Step 2: KJV numbering -> target version. Overrides win, then deltas.
  const o = applyOverrides(overrides[to.meta.id], kjv.bookNr, kjv.chapter, kjv.verse)
  if (o) return getVerse(to, o.bookNr, o.chapter, o.verse)

  const target =
    kjv.verse + (mappings[to.meta.id]?.[`${kjv.bookNr}:${kjv.chapter}`] ?? 0)
  return getVerse(to, kjv.bookNr, kjv.chapter, target)
}

// ---- Chapter navigation ----

export function nextVerse(bible: Bible, v: Verse): Verse | null {
  const i = bible.verses.findIndex(
    (x) => x.bookNr === v.bookNr && x.chapter === v.chapter && x.verse === v.verse
  )
  if (i === -1 || i === bible.verses.length - 1) return null
  const n = bible.verses[i + 1]
  return n.bookNr === v.bookNr ? n : null
}

export function prevVerse(bible: Bible, v: Verse): Verse | null {
  const i = bible.verses.findIndex(
    (x) => x.bookNr === v.bookNr && x.chapter === v.chapter && x.verse === v.verse
  )
  if (i <= 0) return null
  const p = bible.verses[i - 1]
  return p.bookNr === v.bookNr ? p : null
}
/** Resolve verse v (from version fromId) into a KJV-or-French-tradition
 *  reference for an ONLINE target, using overrides + deltas on the source side
 *  and tradition rules on the target side. */
export function resolveParallelRef(
  v: Verse,
  fromId: string,
  targetTradition: "kjv" | "french",
  frenchRules: OverrideRule[] | undefined,
  mappings: Mappings,
  overrides: Overrides
): Ref {
  // Step 1: source -> KJV numbering (identical to resolveParallel's step 1).
  let kjv: Ref
  const rev = reverseOverrides(overrides[fromId], v.bookNr, v.chapter, v.verse)
  if (rev) {
    kjv = rev
  } else {
    kjv = {
      bookNr: v.bookNr,
      chapter: v.chapter,
      verse: v.verse - (mappings[fromId]?.[`${v.bookNr}:${v.chapter}`] ?? 0),
    }
  }

  // Step 2: KJV numbering -> target tradition.
  if (targetTradition === "kjv") return kjv
  const o = applyOverrides(frenchRules, kjv.bookNr, kjv.chapter, kjv.verse)
  return o ?? kjv // French tradition: structural overrides only (psalm-title deltas unknowable online)
}