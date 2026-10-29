// Wake-word command parsing tests — run with:  npx tsx scripts/test-wakeword.ts
import { detectWakeCommand, detectBareCommand, containsWakeWord } from "../src/lib/wakeWord"

let pass = 0
let fail = 0

function t(input: string, check: (c: ReturnType<typeof detectWakeCommand>) => boolean, label: string) {
  const c = detectWakeCommand(input)
  if (check(c)) {
    pass++
    console.log(`  ok  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label}\n      input: ${input}\n      got: ${JSON.stringify(c)}`)
  }
}

// --- scripture (EN/FR/RW) ---
t("Emet give me John 4 verse 5",
  (c) => c?.intent === "scripture" && c.ref.bookNr === 43 && c.ref.chapter === 4 && c.ref.verse === 5,
  "EN: Emet give me John 4:5")
t("emmett show us Romans chapter 8 verse 28",
  (c) => c?.intent === "scripture" && c.ref.chapter === 8 && c.ref.verse === 28,
  "EN: mishear 'emmett' + Romans 8:28")
t("Emet dusome muri Yohana umutwe wa gatatu umurongo wa cumi na gatandatu",
  (c) => c?.intent === "scripture" && c.ref.bookNr === 43 && c.ref.chapter === 3 && c.ref.verse === 16,
  "RW: Emet dusome Yohana 3:16 (spoken numbers)")
t("Emet montre nous Jean chapitre trois verset seize",
  (c) => c?.intent === "scripture" && c.ref.bookNr === 43 && c.ref.chapter === 3 && c.ref.verse === 16,
  "FR: Emet montre Jean 3:16")
t("and the lord spoke emet zaburi 23 1",
  (c) => c?.intent === "scripture" && c.ref.chapter === 23 && c.ref.verse === 1,
  "RW: wake word mid-sentence, Zaburi 23:1")

// --- definitions ---
t("Emet find me the hebrew clear definition of Elohim",
  (c) => c?.intent === "define" && c.term === "elohim" && c.scope === "hebrew",
  "EN: hebrew definition of Elohim")
t('Emet what does "agape" mean in greek',
  (c) => c?.intent === "define" && c.term === "agape" && c.scope === "greek",
  "EN: what does agape mean (greek)")
t("Emet definition of shalom",
  (c) => c?.intent === "define" && c.term === "shalom",
  "EN: definition of shalom")
t("Emet igisobanuro cya elohim mu giheburayo",
  (c) => c?.intent === "define" && c.term === "elohim" && c.scope === "hebrew",
  "RW: igisobanuro cya elohim (heburayo)")
t("Emet sobanura ijambo agape",
  (c) => c?.intent === "define" && c.term === "agape",
  "RW: sobanura ijambo agape")
t("Emet que signifie le mot logos en grec",
  (c) => c?.intent === "define" && c.term.includes("logos") && c.scope === "greek",
  "FR: que signifie logos (grec)")

// --- knowledge ---
t("Emet who was Mao Zedong",
  (c) => c?.intent === "knowledge" && c.topic === "mao zedong",
  "EN: who was Mao Zedong")
t("Emet tell me about the Roman Empire",
  (c) => c?.intent === "knowledge" && c.topic.includes("roman empire"),
  "EN: tell me about the Roman Empire")
t("Emet ni nde Mao Zedong",
  (c) => c?.intent === "knowledge" && c.topic.includes("mao"),
  "RW: ni nde Mao Zedong")
t("Emet qui est Napoleon Bonaparte",
  (c) => c?.intent === "knowledge" && c.topic.includes("napoleon"),
  "FR: qui est Napoleon")
t("Emet mao zedong empire",
  (c) => c?.intent === "knowledge" && c.topic.includes("mao zedong"),
  "EN: bare topic fallback")

// --- control ---
t("Emet next verse", (c) => c?.intent === "control" && c.action === "next", "EN: next verse")
t("Emet umurongo ukurikira", (c) => c?.intent === "control" && c.action === "next", "RW: umurongo ukurikira")
t("Emet clear the screen", (c) => c?.intent === "control" && c.action === "blank", "EN: clear screen")
t("Emet siba", (c) => c?.intent === "control" && c.action === "blank", "RW: siba")
t("Emet verset precedent", (c) => c?.intent === "control" && c.action === "prev", "FR: verset precedent")

// --- non-commands must NOT fire ---
t("and god so loved the world that he gave his only son",
  (c) => c === null, "no wake word -> null")
t("Emet", (c) => c === null, "bare wake word -> null (waits for command)")
t("Emet show us", (c) => c === null, "scripture verb without ref -> null (waits)")

// --- new wake variants + goto ---
t("emit next verse", (c) => c?.intent === "control" && c.action === "next", "EN: mishear 'emit' + next")
t("Emet verse ten", (c) => c?.intent === "goto" && c.verse === 10, "EN: Emet verse ten -> goto 10")
t("Emet umurongo wa cumi na kabiri", (c) => c?.intent === "goto" && c.verse === 12, "RW: Emet umurongo 12 -> goto")

// --- "search me a word called…" + split-utterance stitching ---
t("emet can you search for me a word called in elohimi",
  (c) => c?.intent === "define" && c.term === "elohimi",
  "EN: search for a word called elohimi (stitched)")
t("emet search for the word agape",
  (c) => c?.intent === "define" && c.term === "agape",
  "EN: search for the word agape")
t("emet shakisha ijambo agape",
  (c) => c?.intent === "define" && c.term === "agape",
  "RW: shakisha ijambo agape")
t("emet can you search for me a word called",
  (c) => c === null,
  "EN: define asked but word not yet said -> null (stays awake)")

// --- bare commands (no wake word) ---
function b(input: string, check: (c: ReturnType<typeof detectBareCommand>) => boolean, label: string) {
  const c = detectBareCommand(input)
  if (check(c)) {
    pass++
    console.log(`  ok  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label}\n      input: ${input}\n      got: ${JSON.stringify(c)}`)
  }
}

b("next verse please", (c) => c?.intent === "control" && c.action === "next", "bare: next verse please")
b("Next verse, please.", (c) => c?.intent === "control" && c.action === "next", "bare: punctuated next verse")
b("komeza", (c) => c?.intent === "control" && c.action === "next", "bare RW: komeza")
b("umurongo ukurikira", (c) => c?.intent === "control" && c.action === "next", "bare RW: umurongo ukurikira")
b("verset suivant", (c) => c?.intent === "control" && c.action === "next", "bare FR: verset suivant")
b("go back", (c) => c?.intent === "control" && c.action === "prev", "bare: go back")
b("previous verse", (c) => c?.intent === "control" && c.action === "prev", "bare: previous verse")
b("clear the screen please", (c) => c?.intent === "control" && c.action === "blank", "bare: clear the screen")
b("siba", (c) => c?.intent === "control" && c.action === "blank", "bare RW: siba")
b("verse twelve", (c) => c?.intent === "goto" && c.verse === 12, "bare: verse twelve -> goto 12")
b("umurongo wa gatandatu", (c) => c?.intent === "goto" && c.verse === 6, "bare RW: umurongo wa gatandatu -> goto 6")
b("let's read John 3 16", (c) => c?.intent === "scripture" && c.ref.bookNr === 43 && c.ref.verse === 16, "bare: let's read John 3:16")
b("dusome muri yohana umutwe wa gatatu umurongo wa cumi na gatandatu",
  (c) => c?.intent === "scripture" && c.ref.chapter === 3 && c.ref.verse === 16, "bare RW: dusome Yohana 3:16")
// …and phrases that must NOT fire:
b("and in the next verse john says something wonderful", (c) => c === null, "bare: mid-sentence 'next verse' -> null")
b("we continue our study of grace", (c) => c === null, "bare: 'we continue…' -> null")
b("the lord will clear a path for you", (c) => c === null, "bare: 'clear a path' -> null")
b("john was in prison", (c) => c === null, "bare: casual sentence with book name -> null")
b("verse after verse god speaks", (c) => c === null, "bare: 'verse after verse' -> null")

// --- the full control surface, by voice ---
const ctl = (input: string, action: string, label: string) =>
  t(input, (c) => c?.intent === "control" && c.action === action, label)

ctl("Emet go live", "golive", "EN: go live")
ctl("Emet show it now", "golive", "EN: show it now")
ctl("Emet remove the scripture", "blank", "EN: remove the scripture")
ctl("Emet take it off the screen", "blank", "EN: take it off the screen")
ctl("Emet kura umurongo", "blank", "RW: kura umurongo")
ctl("Emet add this to the queue", "queue", "EN: add to queue")
ctl("Emet clear the queue", "queueClear", "EN: clear the queue")
ctl("Emet next from the queue", "queueNext", "EN: next from queue")
ctl("Emet hide the first version", "hidePrimary", "EN: hide first version")
ctl("Emet show the first version", "showPrimary", "EN: show first version")
ctl("Emet automatic mode", "auto", "EN: auto mode")
ctl("Emet suggestion mode", "suggest", "EN: suggest mode")
ctl("Emet open the display", "display", "EN: open display")
ctl("Emet fungura ekrani", "display", "RW: fungura ekrani")
ctl("Emet stop listening", "stop", "EN: stop listening")
ctl("Emet repeat that", "again", "EN: repeat that")
ctl("Emet subiramo", "again", "RW: subiramo")
ctl("Emet efface l ecran", "blank", "FR: efface l'ecran")
ctl("Emet ajoute a la liste", "queue", "FR: ajoute a la liste")

t("Emet chapter five", (c) => c?.intent === "gotoChapter" && c.chapter === 5 && c.verse === null,
  "EN: chapter five")
t("Emet chapter 5 verse 3", (c) => c?.intent === "gotoChapter" && c.chapter === 5 && c.verse === 3,
  "EN: chapter 5 verse 3")
t("Emet igice cya gatanu", (c) => c?.intent === "gotoChapter" && c.chapter === 5, "RW: igice cya gatanu")
t("Emet chapitre trois", (c) => c?.intent === "gotoChapter" && c.chapter === 3, "FR: chapitre trois")

t("Emet switch to the king james", (c) => c?.intent === "version" && c.version === "kjv" && c.slot === "primary",
  "EN: switch to King James")
t("Emet add bibiliya yera", (c) => c?.intent === "version" && c.version === "by" && c.slot === "second",
  "RW: add Bibiliya Yera as second")
t("Emet use louis segond", (c) => c?.intent === "version" && c.version === "ls1910", "FR: use Louis Segond")

// The two online versions, and the ways speech recognition mangles "NIV".
t("Emet give me the niv version", (c) => c?.intent === "version" && c.version === "yv-niv",
  "EN: give me the NIV version")
t("Emet give me a navy version", (c) => c?.intent === "version" && c.version === "yv-niv",
  "EN: 'navy' misheard for NIV")
t("Emet show me the n i v", (c) => c?.intent === "version" && c.version === "yv-niv",
  "EN: NIV spelled out letter by letter")
t("Emet switch to the new international version",
  (c) => c?.intent === "version" && c.version === "yv-niv", "EN: New International Version")
t("Emet the niv version", (c) => c?.intent === "version" && c.version === "yv-niv",
  "EN: named with no verb at all")
t("Emet donne moi la bible du semeur", (c) => c?.intent === "version" && c.version === "yv-bds",
  "FR: Bible du Semeur")
t("Emet mpa bibiliya yera", (c) => c?.intent === "version" && c.version === "by",
  "RW: mpa Bibiliya Yera")

// --- the name alone is not a question (from a real service) ---
// "Emmett is ready" was turned into a knowledge query about "is ready", and
// EmetAI put a Greek word-study of *readiness* on the wall while the preacher
// was actually asking for a verse in Jeremiah. Words that follow the name are
// only a subject when they READ like one.
t("Emmett is ready", (c) => c === null, "EN: 'Emmett is ready' asks nothing")
t("Emet it is finished", (c) => c === null, "EN: a fragment starting with a pronoun asks nothing")
t("Emet and then he said", (c) => c === null, "EN: a conjunction tail asks nothing")
t("Emet that was powerful", (c) => c === null, "EN: a remark asks nothing")
t("Emet we are ready to begin", (c) => c === null, "EN: talking to the room asks nothing")
// …but a bare subject after the name still works.
t("Emet mao zedong empire",
  (c) => c?.intent === "knowledge" && c.topic === "mao zedong empire",
  "EN: a bare subject is still a question")
t("Emet photosynthesis in plants",
  (c) => c?.intent === "knowledge" && c.topic.includes("photosynthesis"),
  "EN: another bare subject")

// --- moving about the app, and the ear itself (from a real service) ---
// "switch off listening" and "open up account" were both spoken on stage and
// both silently ignored: the stop pattern only knew stop/quit/pause, and
// there was no navigation action at all.
const ctlNav = (phrase: string, action: string, label: string) =>
  t("Emet " + phrase, (c) => c?.intent === "control" && c.action === action, label)

ctlNav("switch off listening", "stop", "EN: switch off listening")
ctlNav("turn off the microphone", "stop", "EN: turn off the microphone")
ctlNav("stop listening", "stop", "EN: stop listening (still works)")
ctlNav("start listening", "listen", "EN: start listening")
ctlNav("switch on the ear", "listen", "EN: switch on the ear")

ctlNav("open up account", "goAccount", "EN: open up account")
ctlNav("open my account", "goAccount", "EN: open my account")
ctlNav("show me my account", "goAccount", "EN: show me my account")
ctlNav("go to admin", "goAdmin", "EN: go to admin")
ctlNav("take us to admin", "goAdmin", "EN: take us to admin")
ctlNav("show me the clips", "goClips", "EN: show me the clips")
ctlNav("open the studio", "goStudio", "EN: open the studio")
ctlNav("take us to the studio", "goStudio", "EN: take us to the studio")
ctlNav("go to the plans", "goPlans", "EN: go to the plans")
ctlNav("fungura konti", "goAccount", "RW: fungura konti")
ctlNav("ouvre mon compte", "goAccount", "FR: ouvre mon compte")

// Navigation must not swallow the commands that already worked.
ctlNav("open the display", "display", "EN: 'open the display' is still the projector")
ctlNav("clear the screen", "blank", "EN: 'clear the screen' unchanged")

// --- going back to something Emet already said ---
t("Emet go back to what you said about psychology",
  (c) => c?.intent === "recall" && c.topic === "psychology", "EN: go back to psychology")
t("Emet what did you say about grace",
  (c) => c?.intent === "recall" && c.topic === "grace", "EN: what did you say about grace")
t("Emet remind me of the mao zedong empire",
  (c) => c?.intent === "recall" && c.topic.includes("mao zedong"), "EN: remind me of…")
t("Emet subira ku ijambo elohim",
  (c) => c?.intent === "recall" && c.topic === "elohim", "RW: subira ku Elohim")
t("Emet reviens a la grace",
  (c) => c?.intent === "recall" && c.topic === "grace", "FR: reviens à la grâce")
// Navigation must never be mistaken for memory.
t("Emet go back to the previous verse",
  (c) => c?.intent === "control" && c.action === "prev", "EN: 'go back to the previous verse' is navigation")
t("Emet go back", (c) => c?.intent === "control" && c.action === "prev",
  "EN: bare 'go back' is still previous verse")

// --- bare (no wake word) control ---
b("clear the queue", (c) => c?.intent === "control" && c.action === "queueClear", "bare: clear the queue")
b("open the display", (c) => c?.intent === "control" && c.action === "display", "bare: open the display")
b("chapter 5", (c) => c?.intent === "gotoChapter" && c.chapter === 5, "bare: chapter 5")
b("switch to the king james", (c) => c?.intent === "version" && c.version === "kjv", "bare: switch version")

// --- ordinary preaching must still not fire these ---
b("i want to add this to the list of things god has done for us this year",
  (c) => c === null, "bare: long sentence with 'add to the list' -> null")
b("let us open the display of gods glory in our hearts today",
  (c) => c === null, "bare: 'open the display' inside a sentence -> null")

// --- navigation the way people actually say it (from real transcripts) ---
const nav = (input: string, verse: number, label: string) => {
  t("Emet " + input, (c) => c?.intent === "goto" && c.verse === verse, "wake: " + label)
  b(input, (c) => c?.intent === "goto" && c.verse === verse, "bare: " + label)
}
nav("go to verse 15", 15, "go to verse 15")
nav("go to the 10th verse", 10, "go to the 10th verse")
nav("go to 4th verse", 4, "go to 4th verse")
nav("jump to verse 7", 7, "jump to verse 7")
nav("take me to the fourth verse", 4, "take me to the fourth verse")
nav("show me verse 9", 9, "show me verse 9")
nav("verse 21", 21, "plain verse 21")
nav("nyereka umurongo wa 12", 12, "RW nyereka umurongo wa 12")
nav("jya ku murongo wa cumi", 10, "RW jya ku murongo wa cumi")
nav("va au verset 15", 15, "FR va au verset 15")
nav("montre moi le quatrieme verset", 4, "FR montre moi le quatrieme verset")

b("go to the next verse", (c) => c?.intent === "control" && c.action === "next",
  "bare: go to the next verse")
b("let us go to the next verse", (c) => c?.intent === "control" && c.action === "next",
  "bare: let us go to the next verse")
b("go to chapter 5", (c) => c?.intent === "gotoChapter" && c.chapter === 5, "bare: go to chapter 5")
b("go to the 5th chapter", (c) => c?.intent === "gotoChapter" && c.chapter === 5, "bare: 5th chapter")
b("igice cya gatanu", (c) => c?.intent === "gotoChapter" && c.chapter === 5, "bare RW: igice cya gatanu")

// "world" is how speech recognition writes "word" — seen in a real service.
t("hi Emmett kindly find for me a world called psychology",
  (c) => c?.intent === "define" && c.term === "psychology",
  "EN: 'a world called psychology' (misheard 'word')")

console.log(containsWakeWord("blah Emet, blah") ? "containsWakeWord ok" : "containsWakeWord BROKEN")
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
