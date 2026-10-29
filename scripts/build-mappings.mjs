// Compares verse counts per chapter across all local Bibles (KJV = reference)
// and writes public/bibles/mappings.json with the offsets.
// Run AFTER importing/re-importing Bibles:  node scripts/build-mappings.mjs

import { readFile, readdir, writeFile } from "node:fs/promises"

const dir = "public/bibles"

async function load(file) {
  return JSON.parse(await readFile(`${dir}/${file}`, "utf8"))
}

/** bible -> { "bookNr:chapter": verseCount } */
function countMap(bible) {
  const counts = {}
  bible.books.forEach((b, i) => {
    const nr = b.nr ?? i + 1
    for (const ch of b.chapters) {
      counts[`${nr}:${ch.chapter}`] = ch.verses.length
    }
  })
  return counts
}

const SKIP = new Set(["mappings.json", "overrides.json", "kjv.json"])

const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !SKIP.has(f))

const kjvCounts = countMap(await load("kjv.json"))
const mappings = {}

for (const file of files) {
  const bible = await load(file)
  if (!Array.isArray(bible.books)) {
    console.log(`${file}: skipped (not a Bible file)`)
    continue
  }
  const id = bible.id
  const counts = countMap(bible)
  const deltas = {}
  let n = 0
  for (const key of Object.keys(counts)) {
    if (key in kjvCounts && counts[key] !== kjvCounts[key]) {
      deltas[key] = counts[key] - kjvCounts[key]
      n++
    }
  }
  if (n > 0) mappings[id] = deltas
  console.log(`${id}: ${n} chapters differ from KJV numbering`)
}

await writeFile(`${dir}/mappings.json`, JSON.stringify(mappings))
console.log("✔ Wrote public/bibles/mappings.json")