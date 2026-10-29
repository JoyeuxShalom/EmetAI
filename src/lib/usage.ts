// Engagement reporting — what the church actually does during a service.
//
// Events are batched and flushed on a timer so a busy service never turns into
// a burst of requests. Only event NAMES leave the machine: never verse text,
// never questions, never audio. The admin sees how much the product is used,
// not what was preached.

import { api, getToken } from "./api"

export type UsageEvent =
  | "verse_shown"
  | "card_shown"
  | "ear_start"
  | "ear_stop"
  | "wake_command"
  | "brain_ask"
  | "quote_matched"
  | "queue_used"
  | "display_opened"
  | "service_started"

const FLUSH_AFTER_MS = 20_000
const MAX_BATCH = 40

let pending: UsageEvent[] = []
let timer: ReturnType<typeof setTimeout> | null = null

async function flush() {
  timer = null
  if (pending.length === 0 || !getToken()) {
    pending = []
    return
  }
  const batch = pending.slice(0, MAX_BATCH)
  pending = pending.slice(MAX_BATCH)
  try {
    await api.reportUsage(batch)
  } catch {
    /* reporting must never interrupt a service */
  }
  if (pending.length > 0) schedule()
}

function schedule() {
  if (timer === null) timer = setTimeout(() => void flush(), FLUSH_AFTER_MS)
}

/** Note that something happened. Cheap, non-blocking, fire-and-forget. */
export function track(event: UsageEvent) {
  if (!getToken()) return
  if (pending.length > 200) return // a runaway loop must not eat memory
  pending.push(event)
  schedule()
}

// Don't lose the last few events when the operator closes the laptop.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => void flush())
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush()
  })
}
