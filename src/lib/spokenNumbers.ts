// Converts spoken number words to digits — English, Kinyarwanda, French.
//   "john chapter three verse sixteen"        -> "john chapter 3 verse 16"
//   "itangiriro umutwe wa mbere umurongo wa kabiri" -> "itangiriro umutwe wa 1 umurongo wa 2"
//   "zaburi ijana na mirongo itanu"           -> "zaburi 150"
//   "jean chapitre treize verset un"          -> "jean chapitre 13 verset 1"
//
// Kinyarwanda numbers carry noun-class prefixes (gatatu / bitatu / itatu are
// all "three"), and the ASR spells them differently per context — every common
// variant is listed.

const ONES: Record<string, number> = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
  // Kinyarwanda (cardinal + ordinal + class variants)
  rimwe: 1, kimwe: 1, mbere: 1, imwe: 1,
  kabiri: 2, babiri: 2, bibiri: 2, ebyiri: 2, ibiri: 2, zibiri: 2,
  gatatu: 3, batatu: 3, bitatu: 3, eshatu: 3, itatu: 3, zitatu: 3,
  kane: 4, bane: 4, bine: 4, enye: 4, ine: 4, zine: 4,
  gatanu: 5, batanu: 5, bitanu: 5, eshanu: 5, itanu: 5, zitanu: 5,
  gatandatu: 6, batandatu: 6, bitandatu: 6, esheshatu: 6, itandatu: 6,
  karindwi: 7, barindwi: 7, birindwi: 7, irindwi: 7, ndwi: 7,
  umunani: 8, munani: 8, inani: 8, umanani: 8,
  icyenda: 9, cyenda: 9, icenda: 9,
  icumi: 10, cumi: 10,
  // French (cardinal + ordinal)
  un: 1, une: 1, premier: 1, premiere: 1,
  deux: 2, deuxieme: 2,
  trois: 3, troisieme: 3,
  quatre: 4, quatrieme: 4,
  cinq: 5, cinquieme: 5,
  sixieme: 6, // "six" collides with English six — same value anyway
  sept: 7, septieme: 7,
  huit: 8, huitieme: 8,
  neuf: 9, neuvieme: 9,
  dix: 10, dixieme: 10,
  onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
}

const TENS: Record<string, number> = {
  // English
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
  // Kinyarwanda
  makumyabiri: 20,
  // French
  vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
}

// Connectors that glue number words together ("cumi na kabiri" = 12,
// "one hundred and nineteen", "cent et un").
const CONNECTORS = new Set(["and", "na", "n", "et"])

export function numberWordsToDigits(text: string): string {
  // French written ordinals from ASR: "1er", "1re", "13e", "2eme" -> digits.
  text = text.replace(/\b(\d+)(?:er|re|eme|e)\b/g, "$1")

  const tokens = text.split(/\s+/)
  const out: string[] = []
  let acc: number | null = null
  let pendingTens = false // saw "mirongo" — next ones word is a tens multiplier
  let pendingHundreds = false // saw "magana" — next ones word is a hundreds multiplier

  const flush = () => {
    if (acc !== null) {
      out.push(String(acc))
      acc = null
    }
    pendingTens = false
    pendingHundreds = false
  }

  for (const t of tokens) {
    if (t === "mirongo") {
      // Kinyarwanda tens: "mirongo itatu" = 30. Keep any hundreds already accumulated.
      if (acc !== null && acc % 100 !== 0) flush()
      pendingTens = true
    } else if (t === "magana") {
      // Kinyarwanda hundreds: "magana abiri" = 200 (multiplier follows).
      flush()
      pendingHundreds = true
    } else if (t in ONES) {
      const v = ONES[t]
      if (pendingHundreds) {
        acc = 100 * v
        pendingHundreds = false
      } else if (pendingTens) {
        acc = (acc ?? 0) + 10 * v
        pendingTens = false
      } else if (acc !== null && acc % 100 === 0 && acc > 0) {
        acc += v // "hundred nineteen" / "ijana na cumi"
      } else if (acc !== null && acc % 10 === 0 && acc >= 10 && v < 10) {
        acc += v // "twenty three" / "cumi na gatandatu" (16) / "dix sept" (17)
      } else if (t === "dix" && (acc === 60 || acc === 80)) {
        acc += 10 // soixante-dix, quatre-vingt-dix
      } else if (acc === 4 && t === "vingt") {
        acc = 80 // never reached — vingt is in TENS; kept for clarity
      } else {
        flush()
        acc = v
      }
    } else if (t in TENS) {
      const v = TENS[t]
      if (acc === 4 && v === 20) {
        acc = 80 // quatre-vingt
      } else if (acc !== null && acc % 100 === 0 && acc > 0) {
        acc += v // "one hundred twenty"
      } else {
        flush()
        acc = v
      }
    } else if (t === "hundred" || t === "ijana" || t === "cent" || t === "cents") {
      acc = (acc ?? 1) * 100
    } else if (CONNECTORS.has(t) && acc !== null && (acc % 10 === 0 || acc % 100 === 0)) {
      continue // swallow the connector between number parts
    } else {
      flush()
      out.push(t)
    }
  }
  flush()
  return out.join(" ")
}
