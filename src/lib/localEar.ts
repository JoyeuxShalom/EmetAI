// Local ear client: streams microphone PCM to the EmetAI backend
// and returns transcripts through the same callback shape as SpeechListener.

import { getToken } from "./api"

type Callbacks = {
    /** `lang` is which language this utterance was actually spoken in —
     *  "rw" | "en" | "fr" | "mixed" — as reported by the ear, not as
     *  configured. In an interpreted service it is the only way to tell the
     *  preacher's sentence from the interpreter's repeat of it. */
    onTranscript: (
      text: string,
      isFinal: boolean,
      lang?: string,
      /** Who the ear thinks said it: "preacher", "interpreter", "speaker 1",
       *  "speaker 2", or "both" when two people spoke over each other and it
       *  refused to guess. Empty until there is enough voice to tell. */
      role?: string,
      /** The ear's own judgement that this was an instruction to EmetAI rather
       *  than preaching. Works in languages no pattern here covers - which is
       *  the point: Kinyarwanda grammar cannot be written as a regex. */
      isRequest?: boolean
    ) => void
    onError: (message: string) => void
    onStatus?: (message: string) => void
    /** Loudness of the room, 0–1, ~20x a second — drives the listening orb. */
    onLevel?: (level: number) => void
  }
  
  /** Close codes the server uses to refuse a connection outright. Retrying any
 *  of these is pointless — nothing about waiting will change the answer. */
const REFUSED = new Set([4401, 4403])

function refusalMessage(code: number): string {
  return code === 4401
    ? "Your session ended — sign in again to keep listening."
    : "The voice assistant is switched off. An administrator can turn it on in Admin → Settings."
}

export class LocalEar {
    private ws: WebSocket | null = null
    private ctx: AudioContext | null = null
    private stream: MediaStream | null = null
    private node: ScriptProcessorNode | null = null
    private stopped = false
    // A backgrounded tab suspends the AudioContext, so the microphone stops
    // producing samples and the ear goes deaf without saying so. Resuming it
    // whenever the tab is touched — and on a timer, because a hidden tab gets
    // no events — is what keeps a service running while the operator checks
    // something in another tab.
    private keepAwake: number | null = null
    private onVisibility: (() => void) | null = null
    // A dropped socket must not end a service — see reconnect().
    private reconnectTimer: number | null = null
    private reconnectAttempts = 0

    async start(lang: "en" | "fr" | "rw" | "auto", cb: Callbacks) {
      this.stopped = false
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
      } catch {
        cb.onError("Microphone permission denied — allow it in the browser address bar.")
        return
      }
  
      // Same-origin via the Vite proxy — no CORS, works when deployed too.
      const proto = window.location.protocol === "https:" ? "wss" : "ws"
      const ws = new WebSocket(
        `${proto}://${window.location.host}/api/ear/ws?lang=${lang}&token=${encodeURIComponent(getToken() ?? "")}`
      )
      ws.binaryType = "arraybuffer"
      this.ws = ws
  
      ws.onopen = () => cb.onStatus?.("connected — loading model…")
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data))
          if (msg.type === "final" && msg.text)
            cb.onTranscript(
              msg.text, true, msg.lang,
              msg.overlap ? "both" : msg.role, msg.request === true
            )
          if (msg.type === "interim" && msg.text)
            cb.onTranscript(msg.text, false, msg.lang)
          if (msg.type === "status" && msg.message) cb.onStatus?.(msg.message)
          // The server reports what the room actually sounds like. If the
          // gate never opens, this is the only way to see why — it used to
          // fail completely silently.
          if (msg.type === "level") {
            cb.onLevel?.(Math.min(1, (msg.rms ?? 0) * 14))
            if (!msg.speaking && (msg.rms ?? 0) < (msg.threshold ?? 1) / 3) {
              cb.onStatus?.("listening — the room is very quiet")
            }
          }
          if (msg.type === "error" && msg.message) {
            this.stopped = true // deliberate server-side failure — don't mask it
            cb.onError(msg.message)
          }
        } catch {
          /* ignore malformed */
        }
      }
      ws.onerror = () => {
        if (!this.stopped) {
          cb.onError(
            "The EmetAI backend is not reachable. Start it with:  python server/app.py"
          )
        }
      }
      ws.onclose = (e) => {
        if (this.stopped) return
        // A refused connection is not a network blip and retrying it for ever
        // just shows "reconnecting…" until somebody notices the wall has gone
        // quiet. Say what actually happened and stop.
        if (REFUSED.has(e.code)) {
          this.stopped = true
          cb.onError(refusalMessage(e.code))
          return
        }
        // A dropped socket used to end listening for good — it only said
        // "disconnected" in small text and went silent. A network blip, a
        // suspended laptop or a backend restart must not end a service, so
        // reconnect and keep going. The microphone itself is untouched, so
        // there is no permission prompt and no gap in capture.
        cb.onStatus?.("reconnecting to the ear…")
        this.reconnect(lang, cb)
      }
  
      // 16 kHz mono capture. ScriptProcessor is deprecated but universally simple.
      const ctx = new AudioContext({ sampleRate: 16000 })
      this.ctx = ctx
      const source = ctx.createMediaStreamSource(this.stream)
      const node = ctx.createScriptProcessor(4096, 1, 1)
      this.node = node
      let lastLevelAt = 0
      node.onaudioprocess = (e) => {
        const pcm = e.inputBuffer.getChannelData(0)
        // `this.ws`, not the socket captured when start() ran — after a
        // reconnect that one is closed and the audio would go nowhere.
        const live = this.ws
        if (live && live.readyState === WebSocket.OPEN) {
          live.send(new Float32Array(pcm).buffer)
        }
        // The same samples power the orb, so it swells on the preacher's
        // actual voice rather than a decorative loop.
        if (cb.onLevel) {
          const now = performance.now()
          if (now - lastLevelAt > 50) {
            lastLevelAt = now
            let sum = 0
            for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i]
            const rms = Math.sqrt(sum / (pcm.length / 4))
            // Speech sits well below full scale; lift it into a usable range.
            cb.onLevel(Math.min(1, rms * 14))
          }
        }
      }
      source.connect(node)
      node.connect(ctx.destination)

      const wake = () => {
        if (this.stopped) return
        if (ctx.state === "suspended") void ctx.resume().catch(() => {})
      }
      this.onVisibility = wake
      document.addEventListener("visibilitychange", wake)
      // A hidden tab receives no visibility events at all, so poll as well.
      this.keepAwake = window.setInterval(wake, 2000)
    }
  
    /** Re-open the socket after a drop, backing off so a backend that is down
     *  is not hammered. The audio graph keeps running throughout; only the
     *  transport is rebuilt. */
    private reconnect(lang: "en" | "fr" | "rw" | "auto", cb: Callbacks) {
      if (this.stopped || this.reconnectTimer !== null) return
      this.reconnectAttempts += 1
      const wait = Math.min(8000, 500 * this.reconnectAttempts)
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null
        if (this.stopped) return
        const proto = window.location.protocol === "https:" ? "wss" : "ws"
        const ws = new WebSocket(
          `${proto}://${window.location.host}/api/ear/ws?lang=${lang}` +
            `&token=${encodeURIComponent(getToken() ?? "")}`
        )
        ws.binaryType = "arraybuffer"
        ws.onopen = () => {
          this.reconnectAttempts = 0
          cb.onStatus?.("listening")
        }
        ws.onmessage = this.ws?.onmessage ?? null
        ws.onerror = () => {}
        ws.onclose = (e) => {
          if (this.stopped) return
          if (REFUSED.has(e.code)) {
            this.stopped = true
            cb.onError(refusalMessage(e.code))
            return
          }
          this.reconnect(lang, cb)
        }
        this.ws = ws
      }, wait)
    }

    /** Ask the server to commit the current utterance NOW — used the moment
     *  the wake word is spotted in an interim, so commands land fast. */
    flush() {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "flush" }))
      }
    }

    stop() {
      this.stopped = true
      if (this.reconnectTimer !== null) {
        window.clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      if (this.keepAwake !== null) {
        window.clearInterval(this.keepAwake)
        this.keepAwake = null
      }
      if (this.onVisibility) {
        document.removeEventListener("visibilitychange", this.onVisibility)
        this.onVisibility = null
      }
      this.node?.disconnect()
      this.ctx?.close()
      this.stream?.getTracks().forEach((t) => t.stop())
      this.ws?.close()
      this.node = null
      this.ctx = null
      this.stream = null
      this.ws = null
    }
  }