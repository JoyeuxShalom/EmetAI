// The live service studio — the heart of EmetAI.
// Loads Bibles + mappings, drives the OperatorView, broadcasts to the display.

import { useEffect, useState } from "react"
import type { ProjectedItem } from "../components/ProjectionView"
import OperatorView from "../components/OperatorView"
import {
  loadBible,
  loadMappings,
  loadOverrides,
  resolveParallel,
  resolveParallelRef,
  VERSIONS,
  type Bible,
  type Mappings,
  type Overrides,
  type Verse,
} from "../data/bible"
import { OnlineBible } from "../data/online"
import type { BrainCard } from "../lib/api"

const channel = new BroadcastChannel("emetai")

// Online Bible clients: created once per window from the static VERSIONS list.
const ONLINE_BIBLES: Record<string, OnlineBible> = {}
for (const v of VERSIONS) {
  if (v.source === "youversion" && v.yvId) {
    ONLINE_BIBLES[v.id] = new OnlineBible(v.yvId, v.label)
  }
}

export default function Studio() {
  const [current, setCurrent] = useState<Verse | null>(null) // primary-resolved verse
  // What answer is on the projector, so the operator can see it too — without
  // this the Studio reported "Screen is idle" while a card was being displayed.
  const [liveCard, setLiveCard] = useState<BrainCard | null>(null)
  const [versionIds, setVersionIds] = useState<string[]>(["by"])
  const [showPrimary, setShowPrimary] = useState(true)
  const [bibles, setBibles] = useState<Record<string, Bible>>({})
  const [mappings, setMappings] = useState<Mappings | null>(null)
  const [overrides, setOverrides] = useState<Overrides | null>(null)
  const [error, setError] = useState<string | null>(null)

  const primaryVersion = VERSIONS.find((v) => v.id === versionIds[0]) ?? null
  const primaryIsOnline = primaryVersion?.source === "youversion"

  // Load mappings + overrides once.
  useEffect(() => {
    loadMappings().then(setMappings)
    loadOverrides().then(setOverrides)
  }, [])

  // Load any selected local Bibles we don't have yet.
  useEffect(() => {
    let cancelled = false
    for (const id of versionIds) {
      const version = VERSIONS.find((v) => v.id === id)
      if (!version || version.source === "youversion") continue
      if (bibles[id]) continue
      loadBible(version)
        .then((b) => {
          if (!cancelled) setBibles((prev) => ({ ...prev, [id]: b }))
        })
        .catch((e) => {
          if (!cancelled) setError(`${version.label}: ${String(e)}`)
        })
    }
    return () => {
      cancelled = true
    }
  }, [versionIds, bibles])

  /** Build and broadcast the projected items for verse v, honoring visibility. */
  async function projectWith(v: Verse | null, includePrimary: boolean) {
    setCurrent(v)
    if (v) setLiveCard(null) // a verse replaces whatever answer was showing
    if (!v) {
      channel.postMessage({ type: "SHOW", items: null })
      return
    }
    const primaryId = versionIds[0]
    // French-tradition override rules (for online targets that follow it).
    const frenchRules =
      (overrides ?? {})["ls1910"] ?? (overrides ?? {})["by"] ?? undefined
    const newItems: ProjectedItem[] = []

    for (const id of versionIds) {
      const version = VERSIONS.find((x) => x.id === id)
      if (!version) continue
      const isPrimary = id === primaryId
      if (isPrimary && !includePrimary) continue // primary drives search, hidden on display

      if (version.source === "youversion") {
        if (isPrimary) {
          newItems.push({ verse: v, label: version.label })
          continue
        }
        const ob = ONLINE_BIBLES[id]
        let verse: Verse | null
        try {
          if (ob) {
            const ref = resolveParallelRef(
              v,
              primaryId,
              version.tradition ?? "kjv",
              frenchRules,
              mappings ?? {},
              overrides ?? {}
            )
            verse = await ob.getVerse(ref.bookNr, v.book, ref.chapter, ref.verse)
          } else {
            verse = null
          }
        } catch {
          verse = null // offline or API error -> honest "not available"
        }
        newItems.push({ verse, label: version.label })
      } else {
        const bible = bibles[id]
        if (!bible) continue
        const verse = isPrimary
          ? v
          : resolveParallel(v, primaryId, bible, mappings ?? {}, overrides ?? {})
        newItems.push({ verse, label: bible.meta.name })
      }
    }

    channel.postMessage({ type: "SHOW", items: newItems })
  }

  function project(v: Verse | null) {
    void projectWith(v, showPrimary)
  }

  /** Put a definition / knowledge card on the wall (replaces any verse). */
  function projectCard(card: BrainCard | null) {
    if (card) setCurrent(null)
    setLiveCard(card)
    channel.postMessage({ type: "SHOW_CARD", card })
  }

  function toggleShowPrimary() {
    const next = !showPrimary
    setShowPrimary(next)
    if (current) void projectWith(current, next)
  }

  function changeVersions(ids: string[]) {
    const unique = Array.from(new Set(ids)).filter(Boolean)
    if (unique.length > 0) setVersionIds(unique)
    setError(null)
  }

  const primaryBible = bibles[versionIds[0]] ?? null
  const localsLoaded = versionIds.every((id) => {
    const v = VERSIONS.find((x) => x.id === id)
    return v?.source === "youversion" ? true : Boolean(bibles[id])
  })

  if (error) {
    return (
      <main className="flex h-full items-center justify-center bg-ink-soft p-8 text-center">
        <div>
          <p className="font-display text-xl text-gold">Bible could not load</p>
          <p className="mt-2 font-sans text-sm text-parchment-dim">{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-4 rounded-md border border-parchment/20 px-3 py-1.5 font-sans text-sm text-parchment-dim hover:border-gold/60 hover:text-gold"
          >
            Try again
          </button>
        </div>
      </main>
    )
  }

  const ready =
    localsLoaded && mappings !== null && overrides !== null && (primaryIsOnline || primaryBible)

  if (!ready) {
    return (
      <main className="flex h-full items-center justify-center bg-ink-soft">
        <p className="animate-pulse-soft font-sans text-sm uppercase tracking-[0.3em] text-parchment-dim/60">
          Preparing the Word…
        </p>
      </main>
    )
  }

  return (
    <OperatorView
      bible={primaryIsOnline ? null : primaryBible}
      primaryOnline={primaryIsOnline ? (ONLINE_BIBLES[versionIds[0]] ?? null) : null}
      primaryLabel={primaryVersion?.label ?? ""}
      versionIds={versionIds}
      mappings={mappings ?? {}}
      overrides={overrides ?? {}}
      onChangeVersions={changeVersions}
      showPrimary={showPrimary}
      onToggleShowPrimary={toggleShowPrimary}
      onProject={project}
      onProjectCard={projectCard}
      nowShowing={current}
      liveCard={liveCard}
    />
  )
}
