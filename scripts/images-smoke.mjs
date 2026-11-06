// Live smoke test for the Agnes image endpoints, through the plugin's own
// loader fetch. Reads AGNES_SAKIKO_API_KEY; it is never printed or written.
//
//   AGNES_SAKIKO_API_KEY=... npm run test:images
//
// This is not part of `bun test`: it sends real image requests.
import { AgnesPlugin, _internal } from "../index.mjs"

const { BASE } = _internal
const key = String(process.env.AGNES_SAKIKO_API_KEY ?? "").trim()
if (!key) {
  console.error("AGNES_SAKIKO_API_KEY is not set; refusing to run a live image test")
  process.exit(2)
}

const plugin = await AgnesPlugin()
const loaded = await plugin.auth.loader(async () => ({ type: "api", key }))
const send = loaded.fetch
const timeout = AbortSignal.timeout(300_000)
const prompt = "a small red circle centered on a plain white background, minimal"

async function call(label, path, init) {
  const started = Date.now()
  try {
    const response = await send(`${BASE}${path}`, { ...init, signal: timeout })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {}
    const item = body?.data?.[0]
    console.log(
      JSON.stringify({
        label,
        status: response.status,
        via: response.headers.get("x-agnes-via"),
        maskIgnored: response.headers.get("x-agnes-mask-ignored"),
        ms: Date.now() - started,
        count: body?.data?.length ?? null,
        url: item?.url ? `${String(item.url).slice(0, 60)}…` : null,
        b64: item?.b64_json ? item.b64_json.length : null,
        error: body?.error?.message ?? null,
      }),
    )
    return { response, body }
  } catch (error) {
    console.log(JSON.stringify({ label, status: "ERR", error: String(error?.message ?? error) }))
    return {}
  }
}

const generation = await call("generations text-to-image", "/images/generations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "agnes-image-2.5-flash",
    prompt,
    size: "1K",
    ratio: "1:1",
    response_format: "url",
  }),
})

await call("generations base64", "/images/generations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "agnes-image-2.5-flash",
    prompt,
    size: "1K",
    response_format: "b64_json",
  }),
})

await call("generations n=2 (fan-out)", "/images/generations", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt, size: "1K", n: 2 }),
})

const url = generation.body?.data?.[0]?.url
if (!url) {
  console.log(JSON.stringify({ label: "edits skipped", reason: "no source image" }))
  process.exit(generation.response?.ok ? 0 : 1)
}

let image
try {
  const response = await fetch(url, { signal: timeout })
  image = new Uint8Array(await response.arrayBuffer())
} catch (error) {
  console.log(JSON.stringify({ label: "edits skipped", reason: String(error?.message ?? error) }))
  process.exit(0)
}

const form = new FormData()
form.set("model", "agnes-image-2.5-flash")
form.set("prompt", "make the circle blue")
form.set("size", "1024x1024")
form.set("image", new Blob([image], { type: "image/png" }), "input.png")
await call("edits multipart", "/images/edits", { method: "POST", body: form })
