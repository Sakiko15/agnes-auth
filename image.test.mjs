import { describe, expect, test } from "bun:test"
import {
  IMAGE_MODELS,
  createImageFetch,
  imageEndpointOf,
  imageModelRow,
  imageReferences,
  imageString,
  isImageModelId,
  normalizeFormat,
  normalizeModel,
  normalizeN,
  normalizeRatio,
  normalizeSize,
} from "./images.mjs"

const KEY = "test-key"
const BASE = "https://apihub.agnes-ai.com/v1"
const auth = { type: "api", key: KEY }
const getAuth = async () => auth
const now = () => 1_700_000_000_000

function jsonRes(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (input, init) => {
    const call = {
      input,
      init,
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function fetchWith(handler) {
  const fetchImpl = fakeFetch(handler)
  const send = createImageFetch({ fetchImpl, getAuth, keyOf: (a) => a?.key ?? "", base: BASE, now })
  return { fetchImpl, send }
}

function imageAnswer(overrides = {}) {
  return {
    created: 1793927603,
    data: [{ url: "https://cdn.example.com/out.png", b64_json: null, revised_prompt: "" }],
    ...overrides,
  }
}

function editForm(extra = {}) {
  const form = new FormData()
  form.set("model", "agnes-image-2.5-flash")
  form.set("prompt", "make it blue")
  form.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png")
  for (const [key, value] of Object.entries(extra)) form.set(key, value)
  return form
}

describe("image helpers", () => {
  test("recognizes the two endpoints and image model ids", () => {
    expect(imageEndpointOf("/v1/images/generations")).toBe("generations")
    expect(imageEndpointOf("/v1/images/edits/")).toBe("edits")
    expect(imageEndpointOf("/v1/chat/completions")).toBe("")
    expect(isImageModelId("agnes-image-2.5-flash")).toBe(true)
    expect(isImageModelId("agnes-3.0-flash")).toBe(false)
  })

  test("normalizes models, sizes, ratios, counts and formats", () => {
    expect(normalizeModel("agnes-sakiko/agnes-image-2.5-flash")).toBe("agnes-image-2.5-flash")
    expect(normalizeModel("agnes/agnes-image-2.5-flash")).toBe("agnes-image-2.5-flash")
    expect(normalizeSize("", "2K")).toBe("2K")
    expect(normalizeSize("auto", "1024x1024")).toBe("1024x1024")
    expect(normalizeSize("2k")).toBe("2K")
    expect(normalizeSize("1024x768")).toBe("1024x768")
    expect(normalizeRatio("16:9")).toBe("16:9")
    expect(normalizeRatio("7:4")).toBe("")
    expect(normalizeN("3")).toBe(3)
    expect(normalizeN(9)).toBe(4)
    expect(normalizeFormat("base64")).toBe("b64_json")
    expect(normalizeFormat("url")).toBe("url")
    expect(normalizeFormat()).toBe("")
    expect(Object.keys(IMAGE_MODELS)).toContain("agnes-image-2.5-flash")
  })

  test("marks image models as image output with no tools", () => {
    const row = imageModelRow("agnes-image-2.5-flash", true, BASE)
    expect(row.modalities).toEqual({ input: ["text", "image"], output: ["image"] })
    expect(row.tool_call).toBe(false)
    expect(row.reasoning).toBe(false)
    expect(row.capabilities).toMatchObject({
      toolcall: false,
      attachment: true,
      output: { text: false, image: true, audio: false, video: false, pdf: false },
    })
  })

  test("collects top-level and extra_body image sources", () => {
    expect(
      imageReferences(
        { image: "https://example.com/a.png" },
        { image: ["data:image/png;base64,aGk="] },
      ),
    ).toEqual(["https://example.com/a.png", "data:image/png;base64,aGk="])
  })

  test("bounds an image source by the 25 MiB input limit", () => {
    const cap = Math.ceil((25 * 1024 * 1024 * 4) / 3) + 8
    const uri = "data:image/png;base64,aGk="
    expect(imageString(uri)).toBe(uri)
    expect(imageString(`data:image/png;base64,${"A".repeat(cap)}`)).toBeNull()
  })
})

describe("generations", () => {
  test("sends an OpenAI-shaped text request as Agnes's JSON, dropping unsupported fields", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: "agnes-sakiko/agnes-image-2.5-flash",
        prompt: "a cat",
        n: 1,
        size: "1024x1024",
        quality: "high",
        background: "opaque",
        output_format: "png",
        user: "someone",
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/images/generations`)
    expect(JSON.parse(fetchImpl.calls[0].init.body)).toEqual({
      model: "agnes-image-2.5-flash",
      prompt: "a cat",
      size: "1024x1024",
    })
    expect(fetchImpl.calls[0].headers.get("authorization")).toBe(`Bearer ${KEY}`)

    const body = await response.json()
    expect(body).toMatchObject({
      created: 1793927603,
      model: "agnes-sakiko/agnes-image-2.5-flash",
      data: [{ url: "https://cdn.example.com/out.png", revised_prompt: "" }],
    })
    expect(response.headers.get("x-agnes-via")).toBe("generations")
  })

  test("asks for base64 the way Agnes accepts, and adds a default size", async () => {
    const { fetchImpl, send } = fetchWith(() =>
      jsonRes(imageAnswer({ data: [{ url: null, b64_json: "aGk=", revised_prompt: "" }] })),
    )
    await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        response_format: "b64_json",
      }),
    })

    expect(JSON.parse(fetchImpl.calls[0].init.body)).toEqual({
      model: "agnes-image-2.5-flash",
      prompt: "a cat",
      size: "2K",
      extra_body: { response_format: "b64_json" },
      return_base64: true,
    })
  })

  test("moves image inputs into extra_body.image and fans out n", async () => {
    const { fetchImpl, send } = fetchWith(() =>
      jsonRes(imageAnswer({ data: [{ url: null, b64_json: "aGk=", revised_prompt: "" }] })),
    )
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "make it blue",
        n: 2,
        image: ["https://example.com/a.png"],
        response_format: "b64_json",
      }),
    })

    expect(fetchImpl.calls).toHaveLength(2)
    for (const call of fetchImpl.calls) {
      expect(JSON.parse(call.init.body)).toEqual({
        model: "agnes-image-2.5-flash",
        prompt: "make it blue",
        size: "2K",
        extra_body: {
          image: ["https://example.com/a.png"],
          response_format: "b64_json",
        },
      })
    }
    expect((await response.json()).data).toHaveLength(2)
  })

  test("serializes a fan-out body once and reuses it", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
    await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat", n: 3 }),
    })

    expect(fetchImpl.calls).toHaveLength(3)
    expect(fetchImpl.calls[1].init.body).toBe(fetchImpl.calls[0].init.body)
    expect(fetchImpl.calls[2].init.body).toBe(fetchImpl.calls[0].init.body)
  })

  test("retries once after a 429 and reports it", async () => {
    let requests = 0
    const { fetchImpl, send } = fetchWith(() => {
      requests++
      if (requests === 1) {
        return jsonRes({ error: { message: "rate limited" } }, 429, { "retry-after": "0" })
      }
      return jsonRes(imageAnswer())
    })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat" }),
    })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls).toHaveLength(2)
    expect(fetchImpl.calls[1].init.body).toBe(fetchImpl.calls[0].init.body)
    expect(response.headers.get("x-agnes-retried")).toBe("true")
    expect((await response.json()).warnings).toContain("retried once after HTTP 429")
  })

  test("reports a capped n, an unsupported ratio and dropped fields", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        n: 6,
        ratio: "7:4",
        quality: "high",
        background: "opaque",
        output_format: "jpeg",
        user: "someone",
        stream: false,
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls).toHaveLength(4)
    for (const call of fetchImpl.calls) {
      expect(JSON.parse(call.init.body)).toEqual({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        size: "2K",
      })
    }
    expect(response.headers.get("x-agnes-n-capped")).toBe("true")
    expect(response.headers.get("x-agnes-ratio-ignored")).toBe("true")
    expect(response.headers.get("x-agnes-ignored-fields")).toBe(
      "quality,background,output_format,user",
    )
    const warnings = (await response.json()).warnings
    expect(warnings).toContain("n was normalized to 4")
    expect(warnings).toContain("ratio is not supported and was ignored")
    expect(warnings).toContain("ignored unsupported field(s): quality, background, output_format, user")
  })

  test("keeps images already generated when a later fan-out request fails", async () => {
    let requests = 0
    const { fetchImpl, send } = fetchWith(() => {
      requests++
      if (requests === 2) return jsonRes({ error: { message: "busy" } }, 503)
      return jsonRes(imageAnswer())
    })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat", n: 2 }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-agnes-partial")).toBe("true")
    expect((await response.json()).data).toHaveLength(1)
    expect(fetchImpl.calls).toHaveLength(2)
  })

  test("propagates an abort or timeout instead of returning 502", async () => {
    for (const [name, message] of [["AbortError", "aborted"], ["TimeoutError", "timed out"]]) {
      const error = new DOMException(message, name)
      const fetchImpl = fakeFetch(() => {
        throw error
      })
      const send = createImageFetch({ fetchImpl, getAuth, keyOf: (a) => a?.key ?? "", base: BASE })
      let caught
      try {
        await send(`${BASE}/images/generations`, {
          method: "POST",
          body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat" }),
        })
      } catch (value) {
        caught = value
      }
      expect(caught).toBe(error)
    }
  })

  test("rejects an image input that is not a URL, data URI or real base64", async () => {
    for (const image of ["input.png", "a long plain description with no punctuation at all"]) {
      const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
      const response = await send(`${BASE}/images/generations`, {
        method: "POST",
        body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat", image }),
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error.param).toBe("image")
      expect(fetchImpl.calls).toHaveLength(0)
    }
  })

  test("uses an existing Authorization instead of asking for the account again", async () => {
    const fetchImpl = fakeFetch(() => jsonRes(imageAnswer()))
    const send = createImageFetch({
      fetchImpl,
      getAuth: async () => {
        throw new Error("sign-in is unavailable")
      },
      keyOf: (a) => a?.key ?? "",
      base: BASE,
    })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      headers: { authorization: "Bearer supplied", "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat" }),
    })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls[0].headers.get("authorization")).toBe("Bearer supplied")
  })

  test("passes a different origin through without rewriting it or reading the account", async () => {
    let authCalls = 0
    const fetchImpl = fakeFetch(() => jsonRes({ ok: true }))
    const send = createImageFetch({
      fetchImpl,
      getAuth: async () => {
        authCalls++
        return auth
      },
      keyOf: (a) => a?.key ?? "",
      base: BASE,
    })
    const url = "https://proxy.example/v1/images/generations"
    const init = { method: "POST", headers: { authorization: "Bearer proxy" }, body: "{}" }
    const response = await send(url, init)

    expect(response.status).toBe(200)
    expect(fetchImpl.calls[0].input).toBe(url)
    expect(fetchImpl.calls[0].init).toBe(init)
    expect(authCalls).toBe(0)
  })

  test("falls back to the current time when created is null", async () => {
    const { send } = fetchWith(() =>
      jsonRes({ created: null, data: [{ url: "https://cdn.example.com/out.png" }] }),
    )
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat" }),
    })
    expect((await response.json()).created).toBe(1_700_000_000)
  })

  test("refuses to inline an image from a private host", async () => {
    const { fetchImpl, send } = fetchWith(() =>
      jsonRes({ created: 1, data: [{ url: "http://[::1]:3000/out.png" }] }),
    )
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        response_format: "b64_json",
      }),
    })
    expect(response.status).toBe(502)
    expect(fetchImpl.calls).toHaveLength(1)
  })

  test("refuses to inline a non-image download", async () => {
    const { send } = fetchWith((call) => {
      if (call.url === "https://cdn.example.com/out.png") {
        return new Response("<html>blocked</html>", { headers: { "content-type": "text/html" } })
      }
      return jsonRes(imageAnswer())
    })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        response_format: "b64_json",
      }),
    })
    expect(response.status).toBe(502)
  })

  test("refuses to inline an oversized download", async () => {
    const { send } = fetchWith((call) => {
      if (call.url === "https://cdn.example.com/out.png") {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          headers: {
            "content-type": "image/png",
            "content-length": String(25 * 1024 * 1024 + 1),
          },
        })
      }
      return jsonRes(imageAnswer())
    })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        response_format: "b64_json",
      }),
    })
    expect(response.status).toBe(502)
  })

  test("returns the base64 images that succeeded when another download fails", async () => {
    let generations = 0
    const { fetchImpl, send } = fetchWith((call) => {
      if (call.url === "https://cdn.example.com/out.png") throw new Error("offline")
      generations++
      if (generations === 1) {
        return jsonRes(imageAnswer({ data: [{ url: null, b64_json: "aGk=" }] }))
      }
      return jsonRes(imageAnswer())
    })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        n: 2,
        response_format: "b64_json",
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-agnes-b64-missing")).toBe("1")
    const body = await response.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].b64_json).toBe("aGk=")
    expect(fetchImpl.calls).toHaveLength(3)
  })

  test("normalizes a bare array, missing defaults and a data URI answer", async () => {
    const pixel = "data:image/png;base64,iVBORw0KGgo="
    const { send } = fetchWith(() => jsonRes({ data: [pixel] }))
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "a cat" }),
    })
    const body = await response.json()
    expect(body.created).toBe(1_700_000_000)
    expect(body.data[0]).toMatchObject({
      url: pixel,
      b64_json: "iVBORw0KGgo=",
      mime_type: "image/png",
      revised_prompt: "a cat",
    })
  })

  test("inlines a URL when base64 was asked for, without sending the key to the image host", async () => {
    const { fetchImpl, send } = fetchWith((call) => {
      if (call.url.startsWith("https://cdn.example.com/")) {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          headers: { "content-type": "image/png" },
        })
      }
      return jsonRes(imageAnswer())
    })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        response_format: "b64_json",
      }),
    })

    const body = await response.json()
    expect(body.data[0].b64_json).toBe("iVBORw0KGgo=")
    expect(body.data[0].mime_type).toBe("image/png")
    const download = fetchImpl.calls[1]
    expect(download.url).toBe("https://cdn.example.com/out.png")
    expect(download.headers.get("authorization")).toBeNull()
  })

  test("passes chat requests through untouched", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes({ ok: true }))
    const url = `${BASE}/chat/completions`
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    const response = await send(url, init)
    expect(response.status).toBe(200)
    expect(fetchImpl.calls[0].input).toBe(url)
    expect(fetchImpl.calls[0].init).toBe(init)
  })

  test("passes a non-POST image path through", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes({ ok: true }))
    await send(`${BASE}/images/generations`, { method: "GET" })
    expect(fetchImpl.calls[0].init.method).toBe("GET")
  })
})

describe("edits", () => {
  test("forwards a multipart edit natively, dropping the mask and unsupported fields", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer({ data: [{ url: "https://cdn.example.com/edit.png" }] })))
    const form = new FormData()
    form.set("model", "agnes-image-2.5-flash")
    form.set("prompt", "make it blue")
    form.set("size", "1024x1024")
    form.set("quality", "high")
    form.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png")
    form.set("mask", new Blob([new Uint8Array([4, 5])], { type: "image/png" }), "m.png")

    const response = await send(`${BASE}/images/edits`, { method: "POST", body: form })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/images/edits`)
    const sent = fetchImpl.calls[0].init.body
    expect(sent).toBeInstanceOf(FormData)
    expect(sent.get("model")).toBe("agnes-image-2.5-flash")
    expect(sent.get("prompt")).toBe("make it blue")
    expect(sent.get("n")).toBe("1")
    expect(sent.get("size")).toBe("1024x1024")
    expect(sent.get("quality")).toBeNull()
    expect(sent.get("mask")).toBeNull()
    expect(sent.get("image")).toBeInstanceOf(Blob)
    const body = await response.json()
    expect(response.headers.get("x-agnes-mask-ignored")).toBe("true")
    expect(response.headers.get("x-agnes-ignored-fields")).toBe("quality")
    expect(response.headers.get("x-agnes-via")).toBe("edits")
    expect(body.warnings).toContain("mask is not supported and was ignored")
    expect(body.warnings).toContain("ignored unsupported field(s): quality")
  })

  test("falls back to generations when the edits backend is unavailable", async () => {
    const { fetchImpl, send } = fetchWith((call) => {
      if (call.url.endsWith("/images/edits")) {
        return jsonRes({ error: { message: "no available server", code: "503" } }, 503)
      }
      return jsonRes(imageAnswer({ data: [{ url: "https://cdn.example.com/edit.png" }] }))
    })
    const form = new FormData()
    form.set("model", "agnes-image-2.5-flash")
    form.set("prompt", "make it blue")
    form.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png")

    const response = await send(`${BASE}/images/edits`, { method: "POST", body: form })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls).toHaveLength(2)
    expect(fetchImpl.calls[1].url).toBe(`${BASE}/images/generations`)
    const sent = JSON.parse(fetchImpl.calls[1].init.body)
    expect(sent.extra_body.image[0]).toStartWith("data:image/png;base64,")
    expect(response.headers.get("x-agnes-via")).toBe("generations-fallback")
  })

  test("skips native edits for five minutes after the backend fails", async () => {
    let clock = 1_700_000_000_000
    const fetchImpl = fakeFetch((call) => {
      if (call.url.endsWith("/images/edits")) {
        return jsonRes({ error: { message: "no available server" } }, 503)
      }
      return jsonRes(imageAnswer())
    })
    const send = createImageFetch({
      fetchImpl,
      getAuth,
      keyOf: (a) => a?.key ?? "",
      base: BASE,
      now: () => clock,
    })

    const first = await send(`${BASE}/images/edits`, { method: "POST", body: editForm() })
    expect(first.status).toBe(200)
    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      `${BASE}/images/edits`,
      `${BASE}/images/generations`,
    ])

    const second = await send(`${BASE}/images/edits`, { method: "POST", body: editForm() })
    expect(second.status).toBe(200)
    expect(second.headers.get("x-agnes-edits-cooldown")).toBe("true")
    expect(second.headers.get("x-agnes-via")).toBe("generations-fallback")
    expect((await second.json()).warnings).toContain(
      "native edits backend was recently unavailable; used generations",
    )
    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      `${BASE}/images/edits`,
      `${BASE}/images/generations`,
      `${BASE}/images/generations`,
    ])

    clock += 5 * 60_000
    await send(`${BASE}/images/edits`, { method: "POST", body: editForm() })
    expect(fetchImpl.calls.map((call) => call.url)).toEqual([
      `${BASE}/images/edits`,
      `${BASE}/images/generations`,
      `${BASE}/images/generations`,
      `${BASE}/images/edits`,
      `${BASE}/images/generations`,
    ])
  })

  test("does not cool down after a request-specific edit error", async () => {
    const fetchImpl = fakeFetch((call) => {
      if (call.url.endsWith("/images/edits")) {
        return jsonRes({ error: { message: "bad image" } }, 422)
      }
      return jsonRes(imageAnswer())
    })
    const send = createImageFetch({ fetchImpl, getAuth, keyOf: (a) => a?.key ?? "", base: BASE, now })

    await send(`${BASE}/images/edits`, { method: "POST", body: editForm() })
    await send(`${BASE}/images/edits`, { method: "POST", body: editForm() })

    expect(fetchImpl.calls.filter((call) => call.url.endsWith("/images/edits"))).toHaveLength(2)
  })

  test("returns 502 instead of re-generating when the edits backend answers without images", async () => {
    const { fetchImpl, send } = fetchWith((call) => {
      if (call.url.endsWith("/images/edits")) return jsonRes({ data: [] })
      return jsonRes(imageAnswer())
    })
    const form = new FormData()
    form.set("model", "agnes-image-2.5-flash")
    form.set("prompt", "make it blue")
    form.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png")

    const response = await send(`${BASE}/images/edits`, { method: "POST", body: form })

    expect(response.status).toBe(502)
    expect(fetchImpl.calls).toHaveLength(1)
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/images/edits`)
    expect((await response.json()).error.message).toContain("no images")
  })

  test("turns a JSON edit with a data URI into an Agnes image-to-image generation", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
    const response = await send(`${BASE}/images/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "make it blue",
        image: "data:image/png;base64,aGk=",
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/images/generations`)
    expect(JSON.parse(fetchImpl.calls[0].init.body).extra_body.image).toEqual([
      "data:image/png;base64,aGk=",
    ])
  })

  test("reads extra_body images and response_format in a JSON edit", async () => {
    const { fetchImpl, send } = fetchWith(() =>
      jsonRes(imageAnswer({ data: [{ url: null, b64_json: "aGk=" }] })),
    )
    const response = await send(`${BASE}/images/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "make it blue",
        extra_body: {
          image: ["data:image/png;base64,aGk="],
          response_format: "b64_json",
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/images/generations`)
    const sent = JSON.parse(fetchImpl.calls[0].init.body)
    expect(sent.extra_body.image).toEqual(["data:image/png;base64,aGk="])
    expect(sent.extra_body.response_format).toBe("b64_json")
  })

  test("keeps a mixed-case multipart boundary intact", async () => {
    const boundary = "----WebKitFormBoundaryABCdef"
    const parts = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      "",
      "agnes-image-2.5-flash",
      `--${boundary}`,
      'Content-Disposition: form-data; name="prompt"',
      "",
      "make it blue",
      `--${boundary}`,
      'Content-Disposition: form-data; name="image"; filename="a.png"',
      "Content-Type: image/png",
      "",
      "abc",
      `--${boundary}--`,
      "",
    ]
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
    const response = await send(`${BASE}/images/edits`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new TextEncoder().encode(parts.join("\r\n")),
    })

    expect(response.status).toBe(200)
    expect(fetchImpl.calls[0].url).toBe(`${BASE}/images/edits`)
  })

  test("sniffs an octet-stream file instead of trusting its type", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { fetchImpl, send } = fetchWith((call) => {
      if (call.url.endsWith("/images/edits")) return jsonRes({}, 503)
      return jsonRes(imageAnswer())
    })
    const form = new FormData()
    form.set("model", "agnes-image-2.5-flash")
    form.set("prompt", "make it blue")
    form.set("image", new Blob([png], { type: "application/octet-stream" }), "a.png")

    const response = await send(`${BASE}/images/edits`, { method: "POST", body: form })

    expect(response.status).toBe(200)
    const sent = JSON.parse(fetchImpl.calls[1].init.body)
    expect(sent.extra_body.image[0]).toStartWith("data:image/png;base64,")
  })

  test("rejects an edit with no image without calling upstream", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
    const response = await send(`${BASE}/images/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x" }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).error.param).toBe("image")
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe("validation and errors", () => {
  test("rejects missing model or prompt without calling upstream", async () => {
    for (const body of [{ prompt: "x" }, { model: "agnes-image-2.5-flash" }]) {
      const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
      const response = await send(`${BASE}/images/generations`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(fetchImpl.calls).toHaveLength(0)
    }
  })

  test("rejects a base64 image object with a non-image MIME type", async () => {
    const { fetchImpl, send } = fetchWith(() => jsonRes(imageAnswer()))
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: "agnes-image-2.5-flash",
        prompt: "a cat",
        image: { b64_json: "aGk=", mime_type: "text/plain" },
      }),
    })

    expect(response.status).toBe(400)
    expect((await response.json()).error.param).toBe("image")
    expect(fetchImpl.calls).toHaveLength(0)
  })

  test("passes an upstream OpenAI error through", async () => {
    const upstream = { error: { message: "prompt is required", type: "invalid_request", code: "invalid_request" } }
    const { send } = fetchWith(() => jsonRes(upstream, 400))
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x" }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(upstream)
  })

  test("rejects an answer whose only image entry is empty", async () => {
    const { send } = fetchWith(() => jsonRes({ created: 1, data: [{ url: null, b64_json: null }] }))
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x" }),
    })
    expect(response.status).toBe(502)
    expect((await response.json()).error.message).toContain("no images")
  })

  test("returns 401 when the account has no key", async () => {
    const fetchImpl = fakeFetch(() => jsonRes(imageAnswer()))
    const send = createImageFetch({ fetchImpl, getAuth: async () => ({}), keyOf: (a) => a?.key ?? "", base: BASE })
    const response = await send(`${BASE}/images/generations`, {
      method: "POST",
      body: JSON.stringify({ model: "agnes-image-2.5-flash", prompt: "x" }),
    })
    expect(response.status).toBe(401)
    expect(fetchImpl.calls).toHaveLength(0)
  })
})
