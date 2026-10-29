// Does a command run exactly as many times as it was meant?
//
// This is the piece that decides whether "next verse" advances once or twice,
// and it now has two ears feeding it: the browser's recogniser acting while
// the words are still being spoken, and Gemini's accurate transcript of the
// same words arriving two to three seconds later.
//
// Both failure directions are visible to a congregation:
//   • too eager  — the verse jumps two at a time
//   • too strict — the preacher says "next" twice and nothing happens
//
// Run:  npx tsx scripts/test-command-gate.ts

import {
  CommandGate,
  CONTROL_DEDUPE_MS,
  FAST_CLAIM_MS,
  MOVEMENT_DEDUPE_MS,
} from "../src/lib/commandGate"

let PASS = 0
let FAIL = 0

function check(label: string, ok: boolean, extra: unknown = "") {
  if (ok) {
    PASS++
    console.log(`  ok  ${label}`)
  } else {
    FAIL++
    console.log(`FAIL  ${label} ${extra === "" ? "" : JSON.stringify(extra)}`)
  }
}

const NEXT = { sig: "c:next", movement: true, control: true }
const VERSE = { sig: "s:43:3:16", movement: false, control: false }
const CLEAR = { sig: "c:clear", movement: false, control: true }

// How long after the trigger lane the accurate ear actually arrives.
const REMOTE_ECHO_MS = 2600

console.log("— one command, two ears —")

{
  const g = new CommandGate()
  const t = 10_000
  const fast = g.admit({ ...NEXT, source: "fast", now: t })
  const echo = g.admit({ ...NEXT, source: "ear", now: t + REMOTE_ECHO_MS })
  check("the trigger lane runs it", fast)
  check("the accurate ear does not run it again", !echo)
}

{
  // The claim must outlast a slow round trip, not just a typical one. Gemini
  // was measured at 13.3s once; 5s of claim would have let that through.
  const g = new CommandGate()
  g.admit({ ...NEXT, source: "fast", now: 0 })
  check("a slow echo is still suppressed",
    !g.admit({ ...NEXT, source: "ear", now: FAST_CLAIM_MS - 100 }))
  check("the claim does eventually expire",
    g.admit({ ...NEXT, source: "ear", now: FAST_CLAIM_MS + 100 }))
}

{
  // A claim is for THAT command, not a blanket mute on the accurate ear.
  const g = new CommandGate()
  g.admit({ ...NEXT, source: "fast", now: 0 })
  check("a different command still runs",
    g.admit({ ...VERSE, source: "ear", now: 500 }))
}

console.log("\n— a person repeating themselves —")

{
  const g = new CommandGate()
  check("first 'next verse' runs", g.admit({ ...NEXT, source: "fast", now: 0 }))
  check("a stutter from the recogniser is dropped",
    !g.admit({ ...NEXT, source: "fast", now: 200 }))
  // Said again, deliberately — roughly how long it takes a person to repeat.
  check("said again a second and a half later, it runs again",
    g.admit({ ...NEXT, source: "fast", now: 1500 }))
}

{
  const g = new CommandGate()
  g.admit({ ...NEXT, source: "fast", now: 0 })
  check("the movement window is short enough to feel responsive",
    MOVEMENT_DEDUPE_MS <= 1000, MOVEMENT_DEDUPE_MS)
  check("and long enough to swallow a stutter",
    !g.admit({ ...NEXT, source: "fast", now: MOVEMENT_DEDUPE_MS - 50 }))
}

{
  // "Clear the screen" twice in a row is almost always the recogniser, not a
  // person — so it gets a longer window than moving between verses.
  const g = new CommandGate()
  g.admit({ ...CLEAR, source: "fast", now: 0 })
  check("a non-movement control holds longer",
    !g.admit({ ...CLEAR, source: "fast", now: CONTROL_DEDUPE_MS - 100 }))
  check("but not for ever",
    g.admit({ ...CLEAR, source: "fast", now: CONTROL_DEDUPE_MS + 100 }))
}

console.log("\n— the trigger lane firing repeatedly as it hears more —")

{
  // Interims arrive every few hundred milliseconds and grow: "next", "next
  // verse", "next verse please". All parse to the same command, and the
  // preacher said it once.
  const g = new CommandGate()
  let ran = 0
  for (const at of [0, 150, 320, 480, 700]) {
    if (g.admit({ ...NEXT, source: "fast", now: at })) ran++
  }
  check("five interims of one phrase run it once", ran === 1, ran)
}

{
  // And the accurate transcript of that same phrase must not add a sixth.
  const g = new CommandGate()
  for (const at of [0, 150, 320, 480, 700]) {
    g.admit({ ...NEXT, source: "fast", now: at })
  }
  check("and the accurate ear adds nothing",
    !g.admit({ ...NEXT, source: "ear", now: 700 + REMOTE_ECHO_MS }))
}

console.log("\n— with no trigger lane at all —")

{
  // The browser may refuse a second recogniser, or the operator may be on an
  // offline ear. Everything must still work, just without the head start.
  const g = new CommandGate()
  check("the accurate ear alone runs the command",
    g.admit({ ...VERSE, source: "ear", now: 0 }))
  check("and is still protected from its own duplicates",
    !g.admit({ ...VERSE, source: "ear", now: 400 }))
}

console.log("\n— a fresh service —")

{
  const g = new CommandGate()
  g.admit({ ...NEXT, source: "fast", now: 0 })
  g.reset()
  check("nothing is carried over from the last service",
    g.admit({ ...NEXT, source: "ear", now: 100 }))
}

console.log(`\n${PASS} passed, ${FAIL} failed`)
process.exit(FAIL ? 1 : 0)
