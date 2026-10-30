// Reveal elements as they come into view.
//
// A landing page that animates everything on load animates most of it where
// nobody can see, then sits still for the rest of the scroll. This watches
// instead, so each section arrives as the reader reaches it.
//
// No library: an IntersectionObserver is a dozen lines and the alternative is
// 30 KB on a page a Rwandan church loads over mobile data.

import { useEffect } from "react"

/** Adds `shown` to every `.reveal` inside the page as it scrolls into view. */
export function useReveal() {
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>(".reveal"))
    if (!targets.length) return

    // Without IntersectionObserver — or with reduced motion asked for —
    // everything is simply visible. A missing animation must never mean
    // missing content.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    if (still || typeof IntersectionObserver === "undefined") {
      targets.forEach((el) => el.classList.add("shown"))
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          entry.target.classList.add("shown")
          observer.unobserve(entry.target)   // reveal once, not on every pass
        }
      },
      // A little early, so the movement finishes before it is fully in view.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
    )
    targets.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])
}
