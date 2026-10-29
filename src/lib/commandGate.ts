// Deciding whether a heard command should actually run.
//
// Two separate problems share one answer, and getting either wrong is visible
// to a congregation:
//
//   1. **The same words arrive twice, from two ears.** The trigger lane (the
//      browser's recogniser) acts while the words are still being spoken; the
//      accurate transcript of the same words arrives from Gemini two or three
//      seconds later. "Next verse" must advance once, not twice.
//
//   2. **The same words arrive twice, from one ear.** A recogniser sometimes
//      emits one utterance more than once within a few hundred milliseconds.
//      That is a duplicate. But a person saying "next verse" twice, a second
//      and a half apart, means it twice — and suppressing that would make
//      EmetAI feel broken in the other direction.
//
// Kept out of the component because it is pure, and because it is exactly the
// kind of timing logic that is impossible to check by reading it.

/** How long the trigger lane owns a command it has already acted on. Must
 *  comfortably exceed the remote ear's round trip (~2.5s) or the slow echo of
 *  a command will slip past the claim and fire a second time. */
export const FAST_CLAIM_MS = 6000

/** A movement command repeated quickly is usually meant. The window only has
 *  to cover a recogniser stuttering, not a person deciding. */
export const MOVEMENT_DEDUPE_MS = 900
export const CONTROL_DEDUPE_MS = 3000
export const DEFAULT_DEDUPE_MS = 10000

export type CommandSource = "ear" | "fast"

export type GateInput = {
  /** Stable identity of the command — same words, same signature. */
  sig: string
  /** Moving through scripture: next/previous verse, go to a verse. */
  movement: boolean
  /** Any other control of the app: clear, show, blank, auto/suggest. */
  control: boolean
  source: CommandSource
  now: number
}

export class CommandGate {
  private lastRun = { sig: "", at: 0 }
  private claimed = { sig: "", at: 0 }

  /** True when this command should execute now. */
  admit(input: GateInput): boolean {
    const { sig, movement, control, source, now } = input

    // The trigger lane already did this one; what has arrived is the slow
    // echo of the same words, not a second instruction.
    if (
      source === "ear" &&
      this.claimed.sig === sig &&
      now - this.claimed.at < FAST_CLAIM_MS
    ) {
      return false
    }

    const window = movement
      ? MOVEMENT_DEDUPE_MS
      : control
        ? CONTROL_DEDUPE_MS
        : DEFAULT_DEDUPE_MS
    if (this.lastRun.sig === sig && now - this.lastRun.at < window) return false

    this.lastRun = { sig, at: now }
    if (source === "fast") this.claimed = { sig, at: now }
    return true
  }

  /** Forget everything — used when listening stops, so a new service does not
   *  inherit a claim from the last one. */
  reset() {
    this.lastRun = { sig: "", at: 0 }
    this.claimed = { sig: "", at: 0 }
  }
}
