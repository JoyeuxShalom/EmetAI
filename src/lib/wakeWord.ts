// The "Emet" wake word — hands-free commands while the preacher preaches.
//
//   "Emet, give me John 4:5"                        -> scripture
//   "Emet, find me the Hebrew definition of Elohim" -> define (scope: hebrew)
//   "Emet, who was Mao Zedong?"                     -> knowledge
//   "Emet, next verse" / "umurongo ukurikira"       -> control
//
// Works in English, French and Kinyarwanda, and tolerates the ways ASR
// mishears the name (Emmett, Emeth, Emedi…).

import { normalize } from "../data/bible"
import { detectReference, type HeardReference } from "./listener"
import { numberWordsToDigits } from "./spokenNumbers"

/** Everything the operator can do by hand, the preacher can now say aloud. */
export type ControlAction =
  | "next"        // next verse
  | "prev"        // previous verse
  | "blank"       // clear the screen
  | "golive"      // project what is staged
  | "again"       // put the last verse back up
  | "queue"       // add what is showing to the service list
  | "queueClear"  // empty the service list
  | "queueNext"   // present the next item from the list
  | "showPrimary" // reveal the first translation
  | "hidePrimary" // hide it
  | "auto"        // project detections without asking
  | "suggest"     // stage detections instead
  | "display"     // open the projector window
  | "stop"        // stop listening
  | "listen"      // start listening again
  // Where in the app to go. "Emet, open my account" was simply ignored before
  // — there was no way for a voice command to move between screens at all.
  | "goStudio"
  | "goAccount"
  | "goAdmin"
  | "goClips"
  | "goPlans"

export type WakeCommand =
  | { intent: "scripture"; ref: HeardReference; heard: string }
  | { intent: "define"; term: string; scope: "hebrew" | "greek" | ""; heard: string }
  | { intent: "knowledge"; topic: string; heard: string }
  | { intent: "control"; action: ControlAction; heard: string }
  | { intent: "goto"; verse: number; heard: string }
  | { intent: "gotoChapter"; chapter: number; verse: number | null; heard: string }
  | { intent: "version"; version: string; slot: "primary" | "second"; heard: string }
  | { intent: "recall"; topic: string; heard: string }

// The name as ASR actually writes it (Emmett, Emeth, emit, Amet, Emedi…).
// Kept bounded on purpose: a false wake during a sermon is worse than a
// missed one (the preacher just repeats).
const WAKE_RE = /\b(emm?[ei]tt?e?|emm?eth|emeti|emedi|amet|aymet|aimet|immet|hemet)\b/g

// Speech-recognition may write the app's name many ways; the *raw* text is
// also checked so "Emet" with punctuation ("Emet,") still matches.
export function containsWakeWord(text: string): boolean {
  WAKE_RE.lastIndex = 0
  return WAKE_RE.test(normalize(text))
}

const FILLER_EDGE =
  /^(?:the|a|an|word|words|please|me|us|for|of|about|in|called|named|clear|good|now|ijambo|ryitwa|yitwa|rya|ry|ya|cya|bwa|wa|mot|le|la|les|du|de|des|d)\s+|\s+(?:please|now|nonaha|maintenant|s il te plait)$/

function cleanTerm(s: string): string {
  let t = s.trim()
  for (let i = 0; i < 6; i++) {
    const next = t.replace(FILLER_EDGE, "").trim()
    if (next === t) break
    t = next
  }
  return t
}

function detectScope(text: string): "hebrew" | "greek" | "" {
  if (/\b(hebrew|hebreu|hebraique|igiheburayo|giheburayo|heburayo)\b/.test(text)) return "hebrew"
  if (/\b(greek|grec|grecque|ikigereki|kigereki|gereki)\b/.test(text)) return "greek"
  return ""
}

const DEFINE_HINT =
  /\b(defin\w*|dictionary|meaning|means|mean|signifi\w*|sobanur\w*|igisobanuro|gisobanuro|ubusobanuro|busobanuro|icyo\s+bivuga|bivuga\s+iki|bisobanuye)\b/

// "search/find me a word called X" — also a definition ask. Speech recognition
// regularly writes "world" for "word", heard in a real service.
const WORD_HUNT =
  /\b(?:search|find|look(?:ing)?(?:\s+up)?|shakisha|ndashaka|cherche[rz]?)\b[\s\S]{0,40}\b(?:words?|worlds?|ijambo|mot)\b|\b(?:words?|worlds?|ijambo|mot)\s+(?:called|named|ryitwa|yitwa)\b/

// A subject begins with the subject. When the words after the name start with
// a copula, an auxiliary or a pronoun they are the tail of a sentence about
// something else — "Emmett is ready" is a remark, not a request, and turning
// it into a question produced a card defining the word "ready" while the
// preacher was actually asking for a verse in Jeremiah.
const FRAGMENT_START =
  /^(?:is|are|was|were|am|be|been|being|will|would|can|could|shall|should|may|might|must|has|have|had|do|does|did|it|its|he|she|they|them|we|us|you|your|i|my|and|but|so|then|that|this|there|here|now|just|also|too|ok|okay|yes|no|ni|ni ko|ariko|none|mais|donc|alors|c est|il|elle)\b/

const KNOWLEDGE_HINT =
  /\b(who\s+(?:is|was|were)|what\s+(?:is|was|are)|tell\s+(?:me|us)\s+about|explain|history\s+of|qui\s+(?:est|etait)|qu\s*est\s*ce\s+que|parle\s*(?:moi|nous)\s+de|c\s*est\s+quoi|explique|histoire\s+de|ni\s+nde|ninde|ni\s+iki|niki|mbwira\s+(?:ibya|ibyerekeye|kuri)|tubwire\s+(?:ibya|ibyerekeye|kuri)|amateka\s+ya)\b/

// Term extraction patterns, tried in order, on the normalized command tail.
const TERM_PATTERNS: RegExp[] = [
  /what\s+does\s+([a-z][a-z' -]*?)\s+mean\b/, // what does elohim mean
  /\bdefine\s+(.{2,50})$/, // define elohim
  /(?:defin\w*|meaning|dictionary)\s+(?:of|for)\s+(.{2,50})$/, // definition of elohim
  /(?:sobanur\w*|igisobanuro|gisobanuro|ubusobanuro|busobanuro)\s*(?:cya|cy|kya|ya|bwa|bw|rya)?\s+(.{2,50})$/, // igisobanuro cya elohim
  /(?:signifi\w*|definition)\s+(?:de|du|d)?\s*(.{2,50})$/, // que signifie elohim
  /\b(?:words?|worlds?|ijambo|mot)\s+(?:called|named|ryitwa|yitwa)?\s*(.{2,40})$/, // word called elohim
  /\b(?:of|about)\s+(.{2,50})$/, // …clear definition of elohim
]

// Every control the operator has, in all three languages. Order matters: the
// first entry whose pattern hits wins, so the specific ones come first.
const CONTROLS: { action: ControlAction; re: RegExp }[] = [
  // Queue — before the plain verbs, "add this to the list" contains no "next".
  { action: "queueClear", re: /\b(?:clear|empty|siba|efface|vide)\s+(?:the\s+|la\s+|le\s+)?(?:queue|list|urutonde|liste)\b|\burutonde\s+(?:siba|hanagura)\b/ },
  { action: "queueNext", re: /\b(?:next|play|present|show)\s+(?:from\s+)?(?:the\s+)?(?:queue|list)\b|\bkurikira\s+ku\s+rutonde\b|\bsuivant\s+de\s+la\s+liste\b/ },
  { action: "queue", re: /\b(?:add|put|save)\s+(?:this|it|that)?\s*(?:to|on|in)?\s*(?:the\s+)?(?:queue|list|urutonde|liste)\b|\bshyira\s+ku\s+rutonde\b|\bajoute[rz]?\s+a\s+la\s+liste\b/ },

  // Screen
  { action: "blank", re: /\b(?:blank|clear|erase|hide|remove|take\s+(?:it\s+)?(?:off|down)|close)\b.{0,18}\b(?:screen|display|scripture|verse|it|ecran|ekrani|umurongo|umutwe)\b|^\s*(?:blank|clear|siba|hanagura|efface|cache)\b|\b(?:siba|hanagura|kura(?:ho)?)\b.{0,12}\b(?:umurongo|ekrani|ecran)\b|\benleve[rz]?\b|\bmasque[rz]?\s+l\s*ecran\b/ },
  { action: "again", re: /\b(?:show|put|bring)\s+(?:it|that)\s+(?:back|again)\b|\brepeat\s+(?:that|it)\b|\bsubiramo\b|\bgaruza\b|\bremontre[rz]?\b|\bencore\s+une\s+fois\b/ },
  { action: "golive", re: /\b(?:go\s+live|show\s+(?:it|this|that)\s+now|put\s+it\s+(?:up|on\s+(?:the\s+)?screen)|project\s+(?:it|this)|erekana\s+(?:ubu|nonaha)|shyira\s+ku\s+ekrani|affiche\s+(?:le|ca)|montre\s+maintenant)\b/ },

  // Translations
  { action: "hidePrimary", re: /\b(?:hide|remove|turn\s+off)\s+(?:the\s+)?(?:first|primary|main|one)\b|\bhomba\s+iya\s+mbere\b|\bcache\s+(?:la\s+)?premiere\b/ },
  { action: "showPrimary", re: /\b(?:show|bring\s+back|turn\s+on)\s+(?:the\s+)?(?:first|primary|main)\b|\berekana\s+iya\s+mbere\b|\bmontre\s+(?:la\s+)?premiere\b/ },

  // How detections behave
  { action: "auto", re: /\b(?:auto(?:matic)?(?:\s+mode)?|automatique)\b(?!\s*off)|\b(?:project|show)\s+automatically\b|\bikore\s+wenyine\b/ },
  { action: "suggest", re: /\b(?:suggest(?:ion)?(?:\s+mode)?|manual(?:\s+mode)?|ask\s+me\s+first|suggestion|manuel)\b|\bmbanza\s+umbaze\b/ },

  // Windows and the ear itself
  { action: "display", re: /\b(?:open|show|launch)\s+(?:the\s+)?(?:display|projector|second\s+screen|ecran|ekrani|projecteur)\b|\bfungura\s+ekrani\b/ },
  // "switch off listening" is how people actually say it — the earlier
  // pattern only knew stop/quit/pause and silently ignored the rest.
  { action: "stop", re: /\b(?:stop|quit|pause|end|switch\s*off|turn\s*off|shut\s*(?:off|down)|close|disable)\s+(?:the\s+)?(?:listening|listen|ear|hearing|microphone|mic)\b|\bhagarara\s+kumva\b|\bzimya\s+(?:ugutega\s+)?amatwi\b|\barrete[rz]?\s+d\s*ecouter\b|\bcoupe[rz]?\s+le\s+micro\b/ },
  { action: "listen", re: /\b(?:start|begin|switch\s*on|turn\s*on|open|enable|resume)\s+(?:the\s+)?(?:listening|listen|ear|hearing|microphone|mic)\b|\btangira\s+kumva\b|\bcommence[rz]?\s+a\s+ecouter\b/ },

  // Navigation — before the movement verbs, because "open the account page"
  // must not be swallowed by the "open"/"next" patterns below.
  { action: "goAccount", re: /\b(?:open|go\s+to|show|take\s+(?:me|us)\s+to|bring\s+up)\s+(?:me\s+|us\s+|up\s+)*(?:my\s+|the\s+)?(?:account|profile|subscription|settings\s+page)\b|\bfungura\s+konti\b|\bouvre\s+(?:mon\s+)?compte\b/ },
  { action: "goAdmin", re: /\b(?:open|go\s+to|show|take\s+(?:me|us)\s+to|bring\s+up)\s+(?:me\s+|us\s+|up\s+)*(?:the\s+)?(?:admin(?:istration|\s+panel|\s+page)?|dashboard)\b|\bfungura\s+ubuyobozi\b|\bouvre\s+l\s*administration\b/ },
  { action: "goClips", re: /\b(?:open|go\s+to|show|take\s+(?:me|us)\s+to|bring\s+up)\s+(?:me\s+|us\s+|up\s+)*(?:the\s+)?(?:clips?|sermon\s+clips?|videos?)\b|\bfungura\s+ibice\b|\bouvre\s+les\s+clips\b/ },
  { action: "goPlans", re: /\b(?:open|go\s+to|show|take\s+(?:me|us)\s+to|bring\s+up)\s+(?:me\s+|us\s+|up\s+)*(?:the\s+)?(?:plans?|pricing|prices|upgrade)\b|\bouvre\s+les\s+(?:plans|tarifs)\b/ },
  { action: "goStudio", re: /\b(?:open|go\s+(?:to|back\s+to)|show|take\s+(?:me|us)\s+(?:to|back))\s+(?:me\s+|us\s+|up\s+)*(?:the\s+)?(?:studio|operator(?:\s+screen)?|main\s+(?:screen|page)|service)\b|\bfungura\s+studio\b|\bouvre\s+le\s+studio\b/ },

  // Movement — last, because "next" appears inside several phrases above.
  { action: "next", re: /\b(?:next|forward|continue|komeza|ukurikira|ikurikira|ikurikiraho|suivant|suivante|prochain|prochaine)\b/ },
  { action: "prev", re: /\b(?:previous|back|go\s+back|last|garuka|subira|inyuma|uwabanje|precedent|precedente|retour|arriere)\b/ },
]

const SCRIPTURE_VERBS =
  /\b(give|show|display|read|open|put|bring|turn\s+to|go\s+to|soma|dusome|nyereka|twereke|zana|shyira|erekana|turebe|reba|fungura|montre|montrez|affiche|lis|lisez|lisons|ouvre|ouvrons|donne|allons)\b/

// Words that carry no meaning in a command ("next verse PLEASE").
const POLITE_RE =
  /\b(please|pls|kindly|thank\s+you|thanks|ok|okay|now|then|murakoze|nonaha|none|yewe|merci|maintenant|s\s*il\s*(?:te|vous)\s*plait|alors|donc)\b/g

// Ordinals, which people use constantly when moving about a chapter and which
// the number parser alone does not cover ("the 4th verse", "the tenth verse").
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
  premier: 1, premiere: 1, deuxieme: 2, troisieme: 3, quatrieme: 4,
  cinquieme: 5, sixieme: 6, septieme: 7, huitieme: 8, neuvieme: 9, dixieme: 10,
}

/** Everything numeric in a phrase, as digits: "the 4th" and "the fourth" both
 *  become "the 4". */
function toDigits(phrase: string): string {
  let p = numberWordsToDigits(phrase)
  p = p.replace(/\b(\d{1,3})(?:st|nd|rd|th)\b/g, "$1") // 4th -> 4
  p = p.replace(/\b[a-z]+\b/g, (w) =>
    ORDINAL_WORDS[w] !== undefined ? String(ORDINAL_WORDS[w]) : w
  )
  return p.replace(/\s+/g, " ").trim()
}

// Nobody says "verse twelve". They say "go to the twelfth verse", "jump to
// verse 12", "take me to verse 12", "nyereka umurongo wa 12". These words
// carry no meaning of their own and are stripped from the front until the
// real command begins.
const NAV_FILLER = new Set([
  "can", "you", "could", "would", "please", "kindly", "just", "now", "lets",
  "let", "us", "we", "go", "goes", "going", "jump", "move", "skip", "take",
  "bring", "me", "show", "display", "read", "open", "turn", "give", "back",
  "to", "at", "on", "the", "a", "an", "of", "and",
  "jya", "genda", "nyereka", "erekana", "twereke", "dusome", "soma",
  "ku", "kuri", "mu", "wa", "ya", "uwa", "cya",
  "va", "vas", "allez", "allons", "montre", "moi", "affiche", "lis",
  "au", "aux", "le", "la", "les", "vers", "sur", "de", "du", "numero", "number",
])

function stripNavFiller(phrase: string): string {
  const words = phrase.split(" ").filter(Boolean)
  let i = 0
  while (i < words.length && NAV_FILLER.has(words[i])) i++
  return words.slice(i).join(" ")
}

// Kinyarwanda and French put a linking word between the noun and its number —
// "umurongo WA 12", "le verset DE 12" — so it has to go from the middle too,
// not only from the front.
const CONNECTOR_RE = /\b(?:wa|ya|cya|rya|bwa|uwa|ku|mu|na|no|le|la|les|au|aux|du|de|d)\b/g

/** A navigation phrase reduced to just its keyword and its number. */
function navCore(phrase: string): string {
  return stripNavFiller(toDigits(phrase))
    .replace(CONNECTOR_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** "verse 12" · "go to the 4th verse" · "umurongo wa 12" · "verset douze" */
function matchGotoVerse(phrase: string): number | null {
  const p = navCore(phrase)
  const word = "verse|verses|verset|versets|umurongo|imirongo|murongo|murongwa"
  // Either order — English puts the number last as often as first.
  let m = p.match(new RegExp(`^(?:${word})\\s+(\\d{1,3})$`))
  if (!m) m = p.match(new RegExp(`^(\\d{1,3})\\s+(?:${word})$`))
  return m ? parseInt(m[1]) : null
}

/** "chapter 5" · "go to the 5th chapter" · "igice cya 5" · "chapitre cinq
 *  verset trois" — stay in the book already on the screen, which is how
 *  preachers actually move about. */
function matchGotoChapter(phrase: string): { chapter: number; verse: number | null } | null {
  const p = navCore(phrase)
  const chap = "chapter|chapters|chapitre|igice|ibice|gice|umutwe|imitwe"
  const vers = "verse|verset|umurongo|murongo"
  let m = p.match(new RegExp(`^(?:${chap})\\s+(\\d{1,3})(?:\\s+(?:${vers})?\\s*(\\d{1,3}))?$`))
  if (!m) m = p.match(new RegExp(`^(\\d{1,3})\\s+(?:${chap})$`))
  return m ? { chapter: parseInt(m[1]), verse: m[2] ? parseInt(m[2]) : null } : null
}

// Translations by the names people actually say for them.
// Spoken letter-by-letter, "NIV" reaches us as "N I V", "and I V", "navy" or
// plain "IV" — speech recognition rarely spells an acronym cleanly. Each
// version therefore carries its mishearings, not just its name.
const VERSION_WORDS: { id: string; re: RegExp }[] = [
  { id: "by", re: /\b(?:bibiliya\s+yera|kinyarwanda|ikinyarwanda|rwandan?)\b/ },
  { id: "kjv", re: /\b(?:king\s+james|kjv|k\s*j\s*v|kay\s*jay\s*vee)\b/ },
  { id: "yv-niv", re: /\b(?:new\s+international|niv|n\s*i\s*v|navy|and\s+i\s*v|in\s+i\s*v|envy)\b/ },
  { id: "web", re: /\b(?:world\s+english|web\s+bible)\b/ },
  { id: "asv", re: /\b(?:american\s+standard|asv|a\s*s\s*v)\b/ },
  { id: "basicenglish", re: /\b(?:basic\s+english|bbe|simple\s+english)\b/ },
  { id: "ls1910", re: /\b(?:louis\s+segond|segond|lsg|ls\s*1910)\b/ },
  { id: "yv-bds", re: /\b(?:bible\s+du\s+semeur|semeur|bds|b\s*d\s*s)\b/ },
  { id: "martin", re: /\b(?:martin)\b/ },
]

/** "switch to the King James" / "give me the NIV version" / "add Bibiliya
 *  Yera" / "montre en francais" */
function matchVersion(phrase: string): { version: string; slot: "primary" | "second" } | null {
  const wantsChange =
    /\b(?:switch|change|use|show|read|put|display|give|bring|open|get|hindura|koresha|erekana|nyereka|mpa|zana|fungura|passe|utilise|montre|affiche|donne|ouvre|mets?)\b/
      .test(phrase)
  const wantsSecond = /\b(?:add|also|second|alongside|beside|with|ongeraho|na\s+|ajoute|deuxieme|aussi)\b/.test(phrase)
  // "the NIV version" / "in Kinyarwanda translation" is a request on its own —
  // no verb survives when the preacher says it as an aside mid-sentence.
  const namesTranslation = /\b(?:version|translation|bible|ubuhinduzi|bibiliya|traduction)\b/.test(phrase)
  if (!wantsChange && !wantsSecond && !namesTranslation) return null
  for (const { id, re } of VERSION_WORDS) {
    if (re.test(phrase)) return { version: id, slot: wantsSecond ? "second" : "primary" }
  }
  return null
}

// Coming back to a subject from earlier in the sermon. This is deliberately
// narrow: it must name what to come back TO, or it would swallow "go back"
// (the previous-verse command) and every other backwards-sounding phrase.
const RECALL_RE = new RegExp(
  "\\b(?:" +
    // "go back to / come back to / return to …"
    "(?:go|come|take (?:me|us)|bring (?:it|that)) back to|return to|back to" +
    "|what (?:did|do) you say(?: again)? about|what you said about|remind (?:me|us) (?:of|about)" +
    "|show (?:me |us )?(?:that |the )?(?:one |thing |answer )?(?:again )?about" +
    // Kinyarwanda: "subira ku…", "garuka ku…", "wavuze iki kuri…"
    "|subira ku|subira kuri|garuka ku|garuka kuri|wavuze iki kuri|wari waravuze kuri" +
    // French: "reviens à…", "retourne à…", "qu'est-ce que tu as dit sur…"
    "|reviens (?:a|sur)|retourne (?:a|sur)|qu est ce que tu as dit sur|ce que tu as dit sur" +
  ")\\s+(.{2,60})$"
)

// "go back to WHAT YOU SAID ABOUT psychology" — the outer phrase matches
// first, so the inner one has to be peeled off the captured topic.
const RECALL_INNER_RE =
  /^(?:what\s+)?(?:you\s+)?(?:said|told\s+(?:me|us)|say)\s+(?:about|on)\s+|^(?:the\s+)?(?:thing|answer|one)\s+about\s+|^ibyo\s+wavuze\s+kuri\s+|^ce\s+que\s+tu\s+as\s+dit\s+sur\s+/

function matchRecall(phrase: string): string | null {
  const m = phrase.match(RECALL_RE)
  if (!m) return null
  const topic = cleanTerm(m[1].replace(RECALL_INNER_RE, "").trim())
  // "go back to the previous verse" is navigation, not memory.
  if (!topic || /\b(?:verse|verset|umurongo|chapter|chapitre|igice|screen|ecran)\b/.test(topic)) {
    return null
  }
  return topic
}

function matchControl(phrase: string): ControlAction | null {
  for (const { action, re } of CONTROLS) {
    if (re.test(phrase)) return action
  }
  return null
}

// Bare commands: the WHOLE utterance is the command (anchored patterns, so
// "in the next verse John says…" never misfires mid-sentence).
const BARE_NEXT =
  /^(?:(?:go\s+)?(?:next|forward)|suivant|suivante|komeza|next\s+(?:verse|one)|(?:le\s+)?verset\s+suivant|prochain\s+verset|umurongo\s+(?:ukurikira|ikurikira|ukurikiraho)|komeza\s+umurongo)$/
const BARE_PREV =
  /^(?:go\s+back|previous|(?:previous|preceding|last)\s+verse|precedent|precedente|(?:le\s+)?verset\s+precedent|verset\s+d\s*avant|garuka|subira|garuka\s+inyuma|subira\s+inyuma|umurongo\s+(?:wabanje|ubanza|w\s*mbere))$/
const BARE_BLANK =
  /^(?:blank|clear|siba|efface|hanagura|(?:clear|blank|hide|close)\s+(?:the\s+)?(?:screen|display)|blank\s+it|siba\s+(?:ecran|ekrani)|efface\s+l?\s*ecran|cache\s+l?\s*ecran|funga\s+(?:ecran|ekrani))$/

/** Commands that work WITHOUT the wake word while the ear is listening:
 *    "next verse please" · "komeza" · "verset suivant" · "clear the screen"
 *    "verse 12" (jump inside the live chapter)
 *    "let's read John 3:16" / "dusome muri Yohana 3:16" (explicit announcement)
 *  Control/goto must be the WHOLE utterance; scripture needs an explicit verb. */
export function detectBareCommand(rawText: string): WakeCommand | null {
  const full = normalize(rawText)
  if (!full) return null
  const t = full.replace(POLITE_RE, " ").replace(/\s+/g, " ").trim()
  if (!t) return null

  // "go to the next verse" is the same command as "next verse"; the words in
  // front of it are politeness, not meaning.
  const core = stripNavFiller(t) || t

  if (BARE_NEXT.test(t) || BARE_NEXT.test(core)) {
    return { intent: "control", action: "next", heard: t }
  }
  if (BARE_PREV.test(t) || BARE_PREV.test(core)) {
    return { intent: "control", action: "prev", heard: t }
  }
  if (BARE_BLANK.test(t) || BARE_BLANK.test(core)) {
    return { intent: "control", action: "blank", heard: t }
  }

  const goto = matchGotoVerse(t)
  if (goto !== null) return { intent: "goto", verse: goto, heard: t }
  const chapter = matchGotoChapter(t)
  if (chapter) return { intent: "gotoChapter", ...chapter, heard: t }

  // The richer controls need the whole utterance to be the command, so an
  // ordinary sentence containing "add this to the list" cannot fire one.
  if (t.length <= 42) {
    const action = matchControl(t)
    if (action && action !== "next" && action !== "prev") {
      return { intent: "control", action, heard: t }
    }
    const version = matchVersion(t)
    if (version) return { intent: "version", ...version, heard: t }
  }

  // An announced reading is a command even mid-flow — but only with an
  // explicit verb AND a parsable reference.
  if (SCRIPTURE_VERBS.test(t)) {
    const ref = detectReference(t)
    if (ref) return { intent: "scripture", ref, heard: ref.heard }
  }
  return null
}

/** Look for "Emet <command>" in a transcript. Returns the parsed command,
 *  or null when the wake word is absent or the command isn't understood yet. */
export function detectWakeCommand(rawText: string): WakeCommand | null {
  const norm = normalize(rawText)
  // Find the LAST wake-word occurrence — the freshest command wins.
  let wakeEnd = -1
  WAKE_RE.lastIndex = 0
  for (const m of norm.matchAll(WAKE_RE)) wakeEnd = (m.index ?? 0) + m[0].length
  if (wakeEnd < 0) return null

  const tail = norm.slice(wakeEnd).trim()
  if (!tail) return null
  const heard = tail.slice(0, 80)

  // 0) "Go back to what you said about grace" — answer it from this
  //    service's own thread rather than asking the model all over again.
  const recalled = matchRecall(tail)
  if (recalled) return { intent: "recall", topic: recalled, heard }

  // 1) Control commands — short, unambiguous, and clearly not a question
  //    ("clear the screen" yes; "the CLEAR definition of…" no).
  if (tail.length <= 55 && !DEFINE_HINT.test(tail) && !KNOWLEDGE_HINT.test(tail)) {
    // "Emet verse 12" / "Emet chapter 5" — move inside what is on the wall.
    const goto = matchGotoVerse(tail)
    if (goto !== null) return { intent: "goto", verse: goto, heard }
    const chapter = matchGotoChapter(tail)
    if (chapter) return { intent: "gotoChapter", ...chapter, heard }
    // "Emet switch to the King James"
    const version = matchVersion(tail)
    if (version) return { intent: "version", ...version, heard }
    const action = matchControl(tail)
    if (action) return { intent: "control", action, heard }
  }

  // 2) A scripture reference beats everything (the core job).
  const ref = detectReference(tail)
  if (ref) return { intent: "scripture", ref, heard }

  // 3) Definition request?
  if (DEFINE_HINT.test(tail) || WORD_HUNT.test(tail)) {
    const scope = detectScope(tail)
    // Prefer a quoted term from the RAW text ('definition of "Elohim"').
    const quoted = rawText.match(/["“”'‘’«»]([^"“”'‘’«»]{2,40})["“”'‘’«»]/)
    let term = quoted ? normalize(quoted[1]) : ""
    if (!term) {
      for (const p of TERM_PATTERNS) {
        const m = tail.match(p)
        if (m) {
          term = m[1]
          break
        }
      }
    }
    term = cleanTerm(term)
    // Scope words sometimes trail the term ("elohim in hebrew").
    term = cleanTerm(
      term.replace(
        /\b(?:in|mu|en)?\s*(?:hebrew|hebreu|hebraique|igiheburayo|giheburayo|heburayo|greek|grec|grecque|ikigereki|kigereki|gereki)\b/g,
        " "
      ).replace(/\s+/g, " ")
    )
    // Connector words are never the term ("…a word called—" cut mid-breath).
    if (/^(?:called|named|ryitwa|yitwa|word|words|ijambo|mot|of|about)$/.test(term)) term = ""
    if (term && term.length >= 2) return { intent: "define", term, scope, heard }
    // A definition was clearly asked but the word hasn't been said yet
    // ("…a word called—") — wait for the next utterance, don't guess.
    return null
  }

  // 4) Knowledge question?
  const km = tail.match(KNOWLEDGE_HINT)
  if (km) {
    const topic = cleanTerm(tail.slice((km.index ?? 0) + km[0].length))
    if (topic.length >= 2) return { intent: "knowledge", topic, heard }
  }

  // 5) Fallback: a bare subject with no question words — "emet mao zedong
  //    empire". A scripture verb with no parsable reference waits for more
  //    words rather than guessing.
  if (SCRIPTURE_VERBS.test(tail)) return null
  const words = tail.split(" ").filter((w) => w.length > 1)
  if (words.length >= 2 && tail.length >= 8 && !FRAGMENT_START.test(tail)) {
    return { intent: "knowledge", topic: cleanTerm(tail), heard }
  }
  return null
}

// ---------------------------------------------------------------------------
// Wake-free listening: is this sentence addressed to the SOFTWARE?
//
// With the Emet button on, the preacher should not have to say the name. But a
// sermon is full of imperatives aimed at the congregation — "please turn with
// me in your bibles", "somebody give the Lord a shout" — and firing on those
// would hijack the screen mid-message. So an imperative verb alone is not
// enough evidence.
//
// The test is: does it name something the SOFTWARE owns (a screen, a verse
// number, a translation, a page), or is it an explicit request for a lookup?
// Congregational imperatives never do; commands to a projector always do.

/** Things only the software has. "bible" is deliberately absent — a preacher
 *  says "open your bibles" to people, not to a projector. */
const APP_OBJECT =
  /\b(?:screen|display|projector|slide|verse|verses|chapter|version|translation|queue|list|account|profile|admin|dashboard|clips?|plans?|pricing|studio|listening|microphone|mic|subtitle|caption|ecran|ekrani|umurongo|umutwe|urutonde|konti|ubuyobozi|igice|verset|chapitre|liste|compte)\b/

// Naming a language is naming a translation: "put it in French", "add
// Kinyarwanda", "show it in English side by side".
const LANGUAGE_NAME =
  /\b(?:english|french|kinyarwanda|swahili|icyongereza|igifaransa|ikinyarwanda|anglais|francais|kinyarwandais|king\s+james|kjv|niv|segond|semeur|bibiliya\s+yera)\b/

/** An explicit request for a lookup or an explanation. */
const ASK_VERB =
  /\b(?:tell\s+(?:me|us)\s+about|explain|define|definition\s+of|what\s+does\s+\S+\s+mean|search\s+for|look\s+up|find\s+me|give\s+me|show\s+me|remind\s+(?:me|us)|mbwira|tubwire|sobanura|nyereka|mpa|shakisha|explique|montre|donne|cherche)\b/

/**
 * An unmistakable request aimed at the software, however long the sentence.
 *
 * A preacher describing the verse they want rather than citing it — "there's a
 * verse in Jeremiah about the Israelites offering to the Queen of Heaven, can
 * you give me that scripture" — is twenty-five words long and is exactly the
 * kind of help this product exists to give. A flat word limit threw it away.
 */
const EXPLICIT_REQUEST =
  /\b(?:can|could|would|will)\s+you\b|\b(?:give|show|find|bring|pull|read|put)\s+(?:me|us)\b|\b(?:that|the|which|what)\s+(?:verse|scripture|passage|chapter)\b|\bwhere\s+(?:is|does)\s+(?:it|the\s+bible)\b|\bumurongo\s+(?:uvuga|wavuga)\b|\bmpa\s+umurongo\b|\bdonne\s*(?:-|\s)?moi\s+(?:le|ce)\s+verset\b|\bquel\s+verset\b/

/** Markers of preaching TO people rather than instructing a machine. */
const CONGREGATION =
  /\b(?:brothers?|sisters?|church|congregation|somebody|everybody|beloved|saints|amen|hallelujah|your\s+bibles?|with\s+me|let\s+us|lets|we\s+are|i\s+want\s+to\s+tell|i\s+believe|i\s+remember|bakristo|bavandimwe|mwese|freres?|soeurs?)\b/

/**
 * Should this sentence be handed to the agent, with no wake word spoken?
 *
 * Deliberately conservative: a missed command costs one repetition, a false
 * one changes the wall in front of a congregation.
 */
export function looksLikeInstruction(rawText: string): boolean {
  const t = normalize(rawText).replace(POLITE_RE, " ").replace(/\s+/g, " ").trim()
  if (!t) return false

  const words = t.split(/\s+/).length

  // An unmistakable request stands on its own, however long — describing the
  // verse you want instead of citing it takes a whole sentence.
  if (EXPLICIT_REQUEST.test(t) && words <= 40) return true

  // Otherwise a whole paragraph is preaching, not an instruction.
  if (words > 14) return false
  // Talking to the room, whatever verbs it contains.
  if (CONGREGATION.test(t)) return false

  // Naming something the software owns is the strongest signal there is.
  if (APP_OBJECT.test(t) || LANGUAGE_NAME.test(t)) return true

  // Otherwise it must be an explicit ask, and a short one.
  if (words <= 10 && ASK_VERB.test(t)) return true

  // A bare question about a subject: "who was Mao Zedong", "what is photosynthesis".
  // Kept short and required to start the sentence, so a rhetorical aside in the
  // middle of a paragraph does not qualify.
  if (words <= 8 && /^(?:who|what|when|where|why|which)\s+(?:is|was|are|were|did|does)\b/.test(t)) {
    return true
  }
  return false
}
