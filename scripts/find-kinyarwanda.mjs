// Lists Bible versions available to your app key for Kinyarwanda, English, French.
// Usage: node scripts/find-kinyarwanda.mjs YOUR_APP_KEY

const key = process.argv[2]
if (!key) {
  console.error("Usage: node scripts/find-kinyarwanda.mjs YOUR_APP_KEY")
  process.exit(1)
}

const INTERESTING = ["yera", "kinyarwanda", "rwanda", "niv", "semeur", "segond", "kjv"]
const hits = []

for (const lang of ["rw", "kin", "en", "fr"]) {
  console.log(`\n=============== language: ${lang} ===============`)
  let pageToken = null
  let count = 0

  do {
    const url = new URL("https://api.youversion.com/v1/bibles")
    url.searchParams.append("language_ranges[]", lang)
    url.searchParams.set("page_size", "99")
    if (pageToken) url.searchParams.set("page_token", pageToken)

    const res = await fetch(url, { headers: { "X-YVP-App-Key": key } })
    const body = await res.text() // read as text first — survives empty bodies

    if (!res.ok) {
      console.error(`HTTP ${res.status}`)
      console.error(body)
      break
    }
    if (!body.trim()) {
      console.log("(empty response — no versions returned for this language)")
      break
    }

    let data
    try {
      data = JSON.parse(body)
    } catch {
      console.error("Response was not valid JSON. First 300 chars:")
      console.error(body.slice(0, 300))
      break
    }

    const list = data.data ?? []
    for (const b of list) {
      count++
      const line = `id=${b.id}\t${b.abbreviation ?? ""}\t${
        b.title ?? b.local_title ?? b.name ?? ""
      }`
      console.log(line)
      const hay = JSON.stringify(b).toLowerCase()
      if (INTERESTING.some((w) => hay.includes(w))) hits.push(`[${lang}] ${line}`)
    }

    pageToken = data.next_page_token ?? null
  } while (pageToken)

  console.log(`--- ${count} versions in "${lang}" ---`)
}

console.log(`\n========== Likely matches for EmetAI ==========`)
for (const h of hits) console.log(h)