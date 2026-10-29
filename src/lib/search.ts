import { normalize, type Bible, type Verse } from "../data/bible"
import { CANONICAL_BOOKS } from "../data/books"

/** "1 sam 3:1" → "1sam 3:1" so numbered books parse as one word. */
function collapseBookNumber(q: string): string {
  return q.replace(/^([1-3])\s+/, "$1")
}

export type ParsedReference = {
  bookNr: number
  book: string // English canonical name
  chapter: number
  verse: number | null
}

/** Parse "john 3:16" / "zaburi 23" / "1cor 13 4" against the canonical book table.
 *  Works for ANY version, including online ones. Requires at least a chapter. */
export function parseReference(query: string): ParsedReference | null {
  const q = collapseBookNumber(normalize(query))
  const m = q.match(/^(\d?[a-z]+)\s+(\d+)(?:[:\s](\d+))?$/)
  if (!m) return null
  const [, word, chapterStr, verseStr] = m

  const book = CANONICAL_BOOKS.find(
    (b) =>
      collapseBookNumber(normalize(b.name)).startsWith(word) ||
      b.aliases.some((a) => a.startsWith(word))
  )
  if (!book) return null

  return {
    bookNr: book.nr,
    book: book.name,
    chapter: parseInt(chapterStr),
    verse: verseStr ? parseInt(verseStr) : null,
  }
}

/** Reference match inside a loaded local Bible (supports chapter-only listing). */
function matchReference(bible: Bible, query: string): Verse[] {
  const q = collapseBookNumber(normalize(query))
  const m = q.match(/^(\d?[a-z]+)\s*(\d+)?(?:[:\s](\d+))?$/)
  if (!m) return []
  const [, word, chapterStr, verseStr] = m

  const book = bible.books.find((b) => {
    const bookName = collapseBookNumber(normalize(b.name))
    return bookName.startsWith(word) || b.aliases.some((a) => a.startsWith(word))
  })
  if (!book) return []

  const chapter = chapterStr ? parseInt(chapterStr) : null
  const verse = verseStr ? parseInt(verseStr) : null

  return bible.verses.filter((v) => {
    if (v.book !== book.name) return false
    if (chapter !== null && v.chapter !== chapter) return false
    if (verse !== null && v.verse !== verse) return false
    return true
  })
}

function matchText(bible: Bible, query: string): Verse[] {
  const q = normalize(query)
  if (q.length < 3) return []
  const out: Verse[] = []
  for (const v of bible.verses) {
    if (v.norm.includes(q)) {
      out.push(v)
      if (out.length >= 12) break // stop early — we only show 12
    }
  }
  return out
}

export function search(bible: Bible, query: string): Verse[] {
  if (!query.trim()) return []
  const byRef = matchReference(bible, query)
  if (byRef.length > 0) return byRef.slice(0, 12)
  return matchText(bible, query)
}