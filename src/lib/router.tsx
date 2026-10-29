// Tiny hash router — no dependency, works with the existing "#display" window.

import { useEffect, useState } from "react"

export function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash)
    window.addEventListener("hashchange", onChange)
    return () => window.removeEventListener("hashchange", onChange)
  }, [])
  return route
}

export function navigate(to: string) {
  window.location.hash = to
}

export function Link({
  to,
  className,
  children,
}: {
  to: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <a href={to} className={className}>
      {children}
    </a>
  )
}
