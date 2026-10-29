// Deciding when a person has actually finished speaking.
//
// Neither ear gives us sentences. Chrome's speech recognition commits a
// "final" result whenever its own segmenter feels like it, which in practice
// cuts people mid-thought — a real transcript from a service reads:
//
//     "what are three main"
//     "quotes of Jesus Christ"
//
// Two finals, one question. Acting on the first produced nonsense and acting
// on the second lost the beginning, so Emet answered neither.
//
// This assembler puts the sentence back together. Every scrap of speech —
// interim or final — resets a silence timer, and only when the room has been
// quiet for a moment is the accumulated text handed on as a complete
// utterance. That is the rule a person would use: wait until they stop
// talking, then answer.

export type UtteranceEvents = {
  /** Everything heard so far this utterance, updated as it arrives. Use for
   *  work that must feel instant; it will keep changing. */
  onPartial: (text: string) => void
  /** The person stopped speaking. This is the whole thing they said. */
  onSettled: (text: string) => void
}

/** How long the room must stay quiet before a sentence counts as finished.
 *
 *  Long enough to survive the pause between "what are three main" and "quotes
 *  of Jesus Christ", short enough that a command still feels immediate. People
 *  pause for roughly 0.5–1s mid-sentence and rather longer at the end of one. */
export const SILENCE_MS = 1600

/** A pause this long ends the utterance immediately — used after a wake word,
 *  where the next words are a command and waiting the full window is dead air
 *  on stage. */
export const COMMAND_SILENCE_MS = 900

/**
 * The window once the words already ARE a command.
 *
 * "next verse" is finished the moment it is said, and waiting out the full
 * silence window to confirm that made the projector feel a beat behind the
 * preacher. Half a second is long enough to tell "next" (end of sentence)
 * from "next week…" (more coming — the gap between words is nearer 150ms),
 * and short enough to feel immediate.
 */
export const FAST_COMMAND_MS = 500

/** Someone can talk for a long time without a real gap. Settle anyway, or a
 *  continuous speaker would never be answered. */
export const MAX_UTTERANCE_MS = 15000

export class UtteranceAssembler {
  private committed = ""      // finals received so far this utterance
  private interim = ""        // the fragment still being spoken
  private timer: number | null = null
  private startedAt = 0
  private lastHeardAt = 0
  private quiet = SILENCE_MS

  private events: UtteranceEvents
  private baseQuiet: number

  /** `baseQuiet` is the window for open speech. The local ear passes a shorter
   *  one because its server has ALREADY waited out a pause before sending a
   *  final — waiting the full window again just doubles the delay. */
  constructor(events: UtteranceEvents, baseQuiet: number = SILENCE_MS) {
    this.events = events
    this.baseQuiet = baseQuiet
    this.quiet = baseQuiet
  }

  /** Feed one result from whichever ear is running. */
  push(text: string, isFinal: boolean) {
    const clean = text.trim()
    if (!clean) return

    if (isFinal) {
      this.committed = `${this.committed} ${clean}`.trim()
      this.interim = ""
    } else {
      this.interim = clean
    }
    if (!this.startedAt) this.startedAt = Date.now()

    this.events.onPartial(this.text())

    // A long enough turn settles on its own, so one unbroken speaker still
    // gets an answer.
    if (Date.now() - this.startedAt >= MAX_UTTERANCE_MS) {
      this.settle()
      return
    }
    this.arm()
  }

  /** Shorten the wait. Used when the wake word is heard, and again — with a
   *  much shorter window — once the running text already parses as a command. */
  expectCommand(ms: number = COMMAND_SILENCE_MS) {
    // Only ever shorten. A later, vaguer hint must not undo a confident one.
    if (ms < this.quiet) this.quiet = ms
    if (this.timer !== null) this.arm()
  }

  /** End the utterance now, whatever the timer says. */
  settle() {
    this.clearTimer()
    const text = this.text()
    this.committed = ""
    this.interim = ""
    this.startedAt = 0
    this.quiet = this.baseQuiet
    if (text) this.events.onSettled(text)
  }

  /** Throw away anything half-heard — used when the microphone closes. */
  reset() {
    this.clearTimer()
    this.committed = ""
    this.interim = ""
    this.startedAt = 0
    this.quiet = this.baseQuiet
  }

  text(): string {
    return `${this.committed} ${this.interim}`.replace(/\s+/g, " ").trim()
  }

  private arm() {
    this.clearTimer()
    this.lastHeardAt = Date.now()
    this.timer = window.setTimeout(() => {
      this.timer = null
      // Background tabs have their timers throttled to once a second or
      // worse, so a fired timer is not proof that the silence really elapsed —
      // and a timer that fires LATE must still settle rather than be ignored.
      // Decide on the clock, not on the timer.
      const quietFor = Date.now() - this.lastHeardAt
      if (quietFor >= this.quiet) this.settle()
      else this.armFor(this.quiet - quietFor)
    }, this.quiet)
  }

  private armFor(ms: number) {
    this.clearTimer()
    this.timer = window.setTimeout(() => {
      this.timer = null
      if (Date.now() - this.lastHeardAt >= this.quiet) this.settle()
      else this.armFor(120)
    }, Math.max(50, ms))
  }

  private clearTimer() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }
}
