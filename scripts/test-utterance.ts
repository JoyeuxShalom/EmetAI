// Deciding when a person has stopped speaking.
// Run:  npx tsx scripts/test-utterance.ts

import {
  UtteranceAssembler,
  SILENCE_MS,
  COMMAND_SILENCE_MS,
  FAST_COMMAND_MS,
  MAX_UTTERANCE_MS,
} from "../src/lib/utterance"

let pass = 0
let fail = 0

function check(label: string, ok: boolean, extra: unknown = "") {
  if (ok) {
    pass++
    console.log(`  ok  ${label}`)
  } else {
    fail++
    console.log(`FAIL  ${label} ${extra ? JSON.stringify(extra) : ""}`)
  }
}

// A clock we control, so a 1.6-second pause costs nothing to test.
type Task = { at: number; fn: () => void; id: number }
let now = 0
let tasks: Task[] = []
let nextId = 1

const g = globalThis as unknown as {
  setTimeout: unknown
  clearTimeout: unknown
  window?: unknown
  Date: DateConstructor
}
const realDateNow = Date.now
g.window = {
  setTimeout: (fn: () => void, ms: number) => {
    const id = nextId++
    tasks.push({ at: now + ms, fn, id })
    return id
  },
  clearTimeout: (id: number) => {
    tasks = tasks.filter((t) => t.id !== id)
  },
}
Date.now = () => now

/** Advance the fake clock, running whatever falls due. */
function tick(ms: number) {
  const until = now + ms
  for (;;) {
    const due = tasks.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    tasks = tasks.filter((t) => t !== due)
    now = due.at
    due.fn()
  }
  now = until
}

function makeAssembler() {
  const settled: string[] = []
  const partials: string[] = []
  const a = new UtteranceAssembler({
    onPartial: (t) => partials.push(t),
    onSettled: (t) => settled.push(t),
  })
  return { a, settled, partials }
}

function reset() {
  now = 0
  tasks = []
}

// ---------------------------------------------------------------------------
console.log("\n— the transcript from a real service —")
reset()
{
  // Exactly what Chrome produced on stage: one question, cut into two finals
  // by its own segmenter, with a short breath between them.
  const { a, settled } = makeAssembler()
  a.push("what are three main", true)
  tick(400) // the speaker draws breath — nothing should fire
  check("a mid-sentence pause does not end the utterance", settled.length === 0, settled)
  a.push("quotes of Jesus Christ", true)
  tick(SILENCE_MS + 50)
  check("the whole question arrives as one", settled.length === 1 && settled[0] === "what are three main quotes of Jesus Christ", settled)
}

reset()
{
  // The other half of that screenshot: the wake word alone on a line.
  const { a, settled } = makeAssembler()
  a.push("Emmett", true)
  tick(500)
  a.push("who is Jesus Christ", true)
  tick(SILENCE_MS + 50)
  check("the wake word joins the question that follows it",
        settled[0] === "Emmett who is Jesus Christ", settled)
}

// ---------------------------------------------------------------------------
console.log("\n— when it does settle —")
reset()
{
  const { a, settled } = makeAssembler()
  a.push("clear the screen", true)
  tick(SILENCE_MS - 200)
  check("it waits out the full silence window", settled.length === 0)
  tick(300)
  check("then settles", settled.length === 1 && settled[0] === "clear the screen", settled)
}

reset()
{
  // After the wake word the window shortens — a command must not sit waiting.
  const { a, settled } = makeAssembler()
  a.push("Emet next verse", true)
  a.expectCommand()
  tick(COMMAND_SILENCE_MS + 50)
  check("a command settles on the shorter window", settled.length === 1, settled)
  check("and that window really is shorter", COMMAND_SILENCE_MS < SILENCE_MS)
}

reset()
{
  const { a, settled } = makeAssembler()
  // Someone who never pauses must still be answered.
  for (let i = 0; i < 40; i++) {
    a.push(`word${i}`, true)
    tick(400)
  }
  check("an unbroken speaker settles on the hard cap", settled.length >= 1, settled.length)
  check("and the cap is generous", MAX_UTTERANCE_MS >= 10000)
}

// ---------------------------------------------------------------------------
console.log("\n— interim text —")
reset()
{
  const { a, settled, partials } = makeAssembler()
  a.push("who is", false)
  a.push("who is Jesus", false)
  tick(200)
  check("partials are reported for the fast path", partials.length === 2, partials)
  check("but nothing has settled yet", settled.length === 0)
  a.push("who is Jesus Christ", true)
  tick(SILENCE_MS + 50)
  check("the final replaces the interim rather than doubling it",
        settled[0] === "who is Jesus Christ", settled)
}

reset()
{
  const { a, settled } = makeAssembler()
  a.push("show me", true)
  a.push(" verses about faith ", false)
  tick(SILENCE_MS + 50)
  check("an interim tail is kept when the room goes quiet",
        settled[0] === "show me verses about faith", settled)
}

reset()
{
  const { a, settled } = makeAssembler()
  a.push("   ", true)
  a.push("", false)
  tick(SILENCE_MS + 50)
  check("silence alone settles nothing", settled.length === 0, settled)
}

// ---------------------------------------------------------------------------
console.log("\n— a finished command should not be made to wait —")
reset()
{
  // The silence window exists to reassemble sentences the recogniser cut in
  // half. "next verse" is not half a sentence, and waiting 1.6s to confirm it
  // made the projector feel a beat behind the preacher every time.
  const { a, settled } = makeAssembler()
  a.push("next verse", false)
  a.expectCommand(FAST_COMMAND_MS)
  tick(FAST_COMMAND_MS + 50)
  check("a recognised command settles fast", settled.length === 1, settled)
  check("and that is well under the open-speech window",
        FAST_COMMAND_MS * 3 < SILENCE_MS, { FAST_COMMAND_MS, SILENCE_MS })
}

reset()
{
  // The safety case: "next" is a command, "next week…" is preaching. The gap
  // between words is ~150ms, far under the fast window.
  const { a, settled } = makeAssembler()
  a.push("next", false)
  a.expectCommand(FAST_COMMAND_MS)
  tick(150)
  a.push("next week we continue this series", false)
  tick(FAST_COMMAND_MS + 50)
  check("a command that turns out to be a sentence is not cut short",
        settled.length === 1 && settled[0] === "next week we continue this series", settled)
}

reset()
{
  // Observed through behaviour rather than internals: with the confident hint
  // in force the command settles on the FAST window, even though a vaguer
  // hint arrived afterwards.
  const { a, settled } = makeAssembler()
  a.push("clear the screen", false)
  a.expectCommand(FAST_COMMAND_MS)
  a.expectCommand(COMMAND_SILENCE_MS) // vaguer hint arrives later
  tick(FAST_COMMAND_MS + 50)
  check("a later, vaguer hint cannot undo a confident one",
        settled.length === 1, settled)
}

reset()
{
  // The local ear's server already waited out 0.65s before sending a final.
  // Paying for that pause twice is where the Kinyarwanda lag came from.
  const settled: string[] = []
  const a = new UtteranceAssembler(
    { onPartial: () => {}, onSettled: (t) => settled.push(t) },
    700
  )
  a.push("komeza", true)
  tick(750)
  check("the local ear settles on its own shorter window", settled.length === 1, settled)
  check("which is well under the browser-ear window", 700 < SILENCE_MS)
}

// ---------------------------------------------------------------------------
console.log("\n— a background tab —")
reset()
{
  // Chrome throttles timers in a hidden tab to once a second or worse, so a
  // timer armed for 1.6s can fire at 5s — or early, if the tab wakes. Neither
  // may lose the sentence. This is what made listening "go off" on a switch.
  const { a, settled } = makeAssembler()
  a.push("switch off listening", true)
  // The throttled timer fires far later than it was armed for.
  tick(5000)
  check("a late timer still settles the sentence", settled.length === 1, settled)
  check("and settles it whole", settled[0] === "switch off listening", settled)
}

reset()
{
  // The other half: a timer that somehow fires EARLY must not cut a speaker off.
  const { a, settled } = makeAssembler()
  a.push("what are three main", true)
  // Fire the pending timer before the silence has actually elapsed.
  now += 200
  const due = tasks.sort((x, y) => x.at - y.at)[0]
  tasks = tasks.filter((t) => t !== due)
  due.fn()
  check("an early timer does not end the sentence", settled.length === 0, settled)
  a.push("quotes of Jesus Christ", true)
  tick(SILENCE_MS + 100)
  check("and the rest still arrives joined on",
        settled[0] === "what are three main quotes of Jesus Christ", settled)
}

// ---------------------------------------------------------------------------
console.log("\n— starting over —")
reset()
{
  const { a, settled } = makeAssembler()
  a.push("first sentence", true)
  tick(SILENCE_MS + 50)
  a.push("second sentence", true)
  tick(SILENCE_MS + 50)
  check("each sentence stands alone", settled.length === 2 && settled[1] === "second sentence", settled)
  check("the first is not repeated into the second", settled[0] === "first sentence", settled)
}

reset()
{
  const { a, settled } = makeAssembler()
  a.push("half a thought", true)
  a.reset()
  tick(SILENCE_MS + 200)
  check("closing the microphone drops what was half-heard", settled.length === 0, settled)
}

Date.now = realDateNow
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
