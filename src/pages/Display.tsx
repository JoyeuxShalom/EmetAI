// The projection window (second screen / projector). Opened from the Studio.
// Receives verses and knowledge cards over a BroadcastChannel — no login needed.

import { useEffect, useState } from "react"
import ProjectionView, { type ProjectedItem } from "../components/ProjectionView"
import type { BrainCard } from "../lib/api"

const channel = new BroadcastChannel("emetai")

export default function Display() {
  const [items, setItems] = useState<ProjectedItem[] | null>(null)
  const [card, setCard] = useState<BrainCard | null>(null)

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "SHOW") {
        setItems(e.data.items as ProjectedItem[] | null)
        setCard(null) // a verse replaces the card
      }
      if (e.data?.type === "SHOW_CARD") {
        setCard(e.data.card as BrainCard | null)
        if (e.data.card) setItems(null) // a card replaces the verses
      }
    }
    channel.addEventListener("message", onMessage)
    return () => channel.removeEventListener("message", onMessage)
  }, [])

  return <ProjectionView items={items} card={card} />
}
