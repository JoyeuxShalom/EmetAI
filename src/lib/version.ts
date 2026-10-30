// Knowing when the Studio is running yesterday's code.
//
// An operator keeps this tab open for hours. After a deploy the page goes on
// running the JavaScript it loaded at the start — a fix that has definitely
// shipped simply appears not to work, and the only clue is something missing
// from the toolbar that nobody knows should be there.
//
// That happened: a new audio-source control was deployed, tested, and then
// reported as absent. It was absent — from a tab opened before the deploy.
//
// So the running build says which version it is, the server says which one it
// is serving, and the Studio can tell the operator plainly. It never reloads
// by itself: a page that refreshes during a sermon is worse than a stale one.

import { useEffect, useState } from "react"

declare const __BUILD_ID__: string

/** The build this page was loaded from. */
export const RUNNING_BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev"

/** How often to look. Rare on purpose — this is a courtesy, not a heartbeat. */
const CHECK_EVERY_MS = 5 * 60 * 1000

/** True once the server is serving a different build than this page is running. */
export function useUpdateAvailable(): boolean {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (RUNNING_BUILD === "dev") return   // vite dev server reloads on its own
    let alive = true

    const look = async () => {
      try {
        // The index page names its own hashed bundle; if that name has
        // changed, the server has a different build to the one running here.
        const html = await fetch("/?v=" + Date.now(), { cache: "no-store" })
          .then((r) => r.text())
        const served = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(html)?.[1]
        const mine = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(
          document.documentElement.innerHTML
        )?.[1]
        if (alive && served && mine && served !== mine) setStale(true)
      } catch {
        /* offline, or the server is restarting — not worth saying anything */
      }
    }

    const timer = window.setInterval(look, CHECK_EVERY_MS)
    // Also when the operator comes back to the tab, which is when they are
    // most likely to be about to use it.
    const onFocus = () => void look()
    window.addEventListener("focus", onFocus)
    void look()

    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  return stale
}
