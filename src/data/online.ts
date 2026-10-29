import { normalize, type Verse } from "./bible"
import { USFM } from "./usfm"

const APP_KEY = import.meta.env.VITE_YVP_APP_KEY as string | undefined

/** Strip HTML tags and verse-number prefixes from passage content. */
function cleanContent(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/^\s*\d+\s*/, "")
    .trim()
}

export class OnlineBible {
  readonly yvId: number
  readonly label: string
  private cache = new Map<string, Verse | null>() // session-only, per license

  constructor(yvId: number, label: string) {
    this.yvId = yvId
    this.label = label
  }

  async getVerse(
    bookNr: number,
    book: string,
    chapter: number,
    verse: number
  ): Promise<Verse | null> {
    if (!APP_KEY) throw new Error("Missing VITE_YVP_APP_KEY in .env.local")
    const usfm = USFM[bookNr]
    if (!usfm) return null

    const key = `${bookNr}:${chapter}:${verse}`
    if (this.cache.has(key)) return this.cache.get(key)!

    const url = `/yv/v1/bibles/${this.yvId}/passages/${usfm}.${chapter}.${verse}`
    const res = await fetch(url, { headers: { "X-YVP-App-Key": APP_KEY } })
    if (!res.ok) {
      if (res.status === 404) {
        this.cache.set(key, null) // verse genuinely absent in this version
        return null
      }
      throw new Error(`YouVersion HTTP ${res.status}`)
    }
    const data = await res.json()
    const raw = data.content ?? data.text ?? ""
    const text = cleanContent(String(raw))
    if (!text) {
      this.cache.set(key, null)
      return null
    }

    const v: Verse = {
      bookNr,
      book,
      chapter,
      verse,
      text,
      norm: normalize(text),
      translation: this.label,
    }
    this.cache.set(key, v)
    return v
  }
}