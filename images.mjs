// Agnes's image endpoints, as magpie's gateway and OpenAI SDKs call them.
//
// magpie draws through the provider's own `fetch` (internal/gateway/draw.go):
//   POST {base}/images/generations  JSON {model, prompt, n, size, ...}
//   POST {base}/images/edits        multipart/form-data, image / image[]
//
// Agnes documents only /v1/images/generations, with image-to-image and
// multi-image input in `extra_body.image` (a public URL or a data URI), and
// sizes as 1K/2K/3K/4K plus a ratio. Its /v1/images/edits exists too, but
// takes the image only as a multipart file upload. This module translates
// both OpenAI-shaped endpoints to what Agnes accepts and normalizes the
// answer back, while every other request (chat completions included) passes
// through untouched.

export const IMAGE_MODELS = {
  "agnes-image-2.5-flash": { name: "Agnes Image 2.5 Flash" },
}

const RATIOS = new Set(["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"])
const FALLBACK_EDIT_STATUSES = new Set([404, 405, 415, 422, 500, 501, 502, 503])
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export function isImageModelId(id) {
  return /^agnes-image-/i.test(String(id ?? ""))
}

// imageEndpointOf is "generations" or "edits" for the two paths magpie and
// OpenAI clients use; "" for anything else.
export function imageEndpointOf(pathname) {
  const match = /\/images\/(generations|edits)\/?$/i.exec(String(pathname ?? ""))
  return match ? match[1].toLowerCase() : ""
}

// normalizeModel strips the provider prefix a caller may have left on.
export function normalizeModel(model) {
  return String(model ?? "").trim().replace(/^agnes(?:-sakiko)?\//i, "")
}

// normalizeSize keeps Agnes's tiers and legacy WxH sizes; auto and empty
// take the fallback (2K for generations, 1024x1024 for edits).
export function normalizeSize(size, fallback = "2K") {
  const value = String(size ?? "").trim()
  if (!value || /^auto$/i.test(value)) return fallback
  if (/^[1-4]k$/i.test(value)) return value.toUpperCase()
  if (/^\d+[x*]\d+$/i.test(value)) return value.replace("*", "x").toLowerCase()
  return value
}

export function normalizeRatio(ratio) {
  const value = String(ratio ?? "").trim()
  return RATIOS.has(value) ? value : ""
}

export function normalizeN(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(MAX_IMAGES, Math.trunc(value)))
}

export function normalizeFormat(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue
    const format = value.trim().toLowerCase()
    if (format === "b64_json" || format === "base64") return "b64_json"
    if (format === "url") return "url"
  }
  return ""
}

export function boolOf(value) {
  return value === true || value === 1 || value === "1" || value === "true"
}

// imageModelRow is an OpenCode/magpie model row for an image model: image
// output, image input, no tools and no reasoning.
export function imageModelRow(id, runtime = false, base = "") {
  const name = IMAGE_MODELS[id]?.name ?? id
  const row = {
    name,
    limit: { context: 0, output: 0 },
    reasoning: false,
    tool_call: false,
    modalities: { input: ["text", "image"], output: ["image"] },
  }
  if (!runtime) return row
  return {
    ...row,
    id,
    providerID: "agnes-sakiko",
    api: { id, url: base, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: true,
      toolcall: false,
      input: { text: true, image: true },
      output: { text: false, image: true, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: {},
    free: false,
  }
}

// imageString is one URL, data URI or raw base64 image as a string Agnes
// accepts; null when the value is not an image source.
export function imageString(value) {
  if (typeof value !== "string") return null
  const text = value.trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) return text
  if (/^data:image\//i.test(text)) return text
  // A bare base64 image is only accepted when it really decodes to an image;
  // otherwise ordinary prose is mistaken for one.
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length > 32 && text.length % 4 === 0) {
    try {
      const mime = detectImageMime(base64Bytes(text))
      if (mime) return `data:${mime};base64,${text}`
    } catch {}
  }
  return null
}

function imageStrings(value, out, invalid) {
  if (Array.isArray(value)) {
    for (const item of value) imageStrings(item, out, invalid)
    return out
  }
  if (value && typeof value === "object" && !(value instanceof Blob)) {
    if (typeof value.url === "string") return imageStrings(value.url, out, invalid)
    if (value.image_url !== undefined) {
      const url = typeof value.image_url === "string" ? value.image_url : value.image_url?.url
      if (typeof url === "string") return imageStrings(url, out, invalid)
      invalid?.push(value)
      return out
    }
    if (typeof value.b64_json === "string" && value.b64_json) {
      const mime = typeof value.mime_type === "string" && value.mime_type ? value.mime_type : "image/png"
      out.push(`data:${mime};base64,${value.b64_json}`)
      return out
    }
    if (typeof value.base64 === "string" && value.base64) {
      const mime = typeof value.mime_type === "string" && value.mime_type ? value.mime_type : "image/png"
      out.push(`data:${mime};base64,${value.base64}`)
      return out
    }
    invalid?.push(value)
    return out
  }
  const one = imageString(value)
  if (one) out.push(one)
  else if (value != null && value !== "") invalid?.push(value)
  return out
}

// imageReferencesDetailed collects top-level and extra_body images without
// duplicates, keeping the values that could not be read so the caller can
// reject them instead of silently dropping part of a multi-image request.
export function imageReferencesDetailed(body, extra = {}) {
  const refs = []
  const invalid = []
  for (const key of ["image", "images"]) imageStrings(body?.[key], refs, invalid)
  for (const key of ["image", "images"]) imageStrings(extra?.[key], refs, invalid)
  return { refs: [...new Set(refs)], invalid }
}

export function imageReferences(body, extra = {}) {
  return imageReferencesDetailed(body, extra).refs
}

export function requestedFormat(body = {}, extra = {}) {
  const explicit = normalizeFormat(body?.response_format, extra?.response_format)
  if (explicit) return explicit
  return boolOf(body?.return_base64) || boolOf(extra?.return_base64) ? "b64_json" : ""
}

// createImageFetch is the loader's fetch. It rewrites only POSTs to this
// provider's own two image paths; everything else goes to fetchImpl exactly
// as it came.
export function createImageFetch({
  fetchImpl = globalThis.fetch,
  getAuth,
  keyOf = defaultKeyOf,
  base,
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is not a function")
  const baseOrigin = new URL(base).origin
  return async function imageFetch(input, init) {
    const requestInit = init ?? {}
    const url = urlOf(input)
    let parsed
    try {
      parsed = new URL(url)
    } catch {}
    const endpoint = parsed ? imageEndpointOf(parsed.pathname) : ""
    const method = String(requestInit.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    // Rewrite only this provider's own origin. A custom base or an unrelated
    // host keeps its request, including its Authorization header, untouched.
    if (!endpoint || parsed.origin !== baseOrigin || method !== "POST") {
      return init === undefined ? fetchImpl(input) : fetchImpl(input, init)
    }

    const headers = new Headers(requestInit.headers ?? (input instanceof Request ? input.headers : undefined))
    const authorization = String(headers.get("authorization") ?? "").trim()
    if (!authorization || /^bearer\s*$/i.test(authorization)) {
      let key = ""
      try {
        key = keyOf(await getAuth())
      } catch {
        return errorResponse(401, "Agnes sign-in could not be read", "missing_api_key")
      }
      if (!key) return errorResponse(401, "Agnes API key is missing", "missing_api_key")
      headers.set("authorization", `Bearer ${key}`)
    }
    const signal = requestInit.signal ?? (input instanceof Request ? input.signal : undefined)
    const body = requestInit.body !== undefined ? requestInit.body : input instanceof Request ? input.clone() : undefined
    const contentType = String(headers.get("content-type") ?? "")

    try {
      if (endpoint === "generations") {
        return await handleGenerations({ body, fetchImpl, base, headers, signal, now })
      }
      return await handleEdits({ body, contentType, fetchImpl, base, headers, signal, now })
    } catch (error) {
      if (abortLike(error) || signal?.aborted) throw error
      return errorResponse(502, error?.message ?? String(error), "upstream_error")
    }
  }
}

async function handleGenerations({ body, fetchImpl, base, headers, signal, now }) {
  let input
  try {
    input = JSON.parse(await textOf(body))
  } catch {
    return badRequest("the request isn't JSON", "invalid_json")
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return badRequest("the request isn't a JSON object", "invalid_json")
  }
  const model = normalizeModel(input.model)
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : ""
  if (!model) return badRequest("model is required", "model")
  if (!prompt) return badRequest("prompt is required", "prompt")

  const extraIn = objectOf(input.extra_body)
  const { refs: images, invalid } = imageReferencesDetailed(input, extraIn)
  if (invalid.length) return badRequest("image is not a URL, data URI, or base64 image", "image")
  const format = requestedFormat(input, extraIn)
  const n = normalizeN(input.n ?? extraIn.n)
  const size = normalizeSize(input.size ?? extraIn.size, "2K")
  const ratio = normalizeRatio(input.ratio ?? extraIn.ratio)
  const requested = {
    endpoint: "generations",
    originalModel: String(input.model),
    model,
    prompt,
    n,
    size,
    ratio,
    responseFormat: format,
    images,
    maskIgnored: input.mask != null,
    via: "generations",
  }
  return await runGenerations({ requested, fetchImpl, base, headers, signal, now, extraIn })
}

async function handleEdits({ body, contentType, fetchImpl, base, headers, signal, now }) {
  let form = null
  let json = null
  if (body instanceof FormData) {
    form = body
  } else if (/^multipart\/form-data\b/i.test(contentType)) {
    try {
      form = await new Response(await bytesOf(body), {
        headers: { "content-type": contentType },
      }).formData()
    } catch {
      return badRequest("the multipart body couldn't be read", "invalid_request")
    }
  } else {
    try {
      json = JSON.parse(await textOf(body))
    } catch {
      return badRequest("send JSON or multipart/form-data", "invalid_json")
    }
  }

  const fields = {}
  const images = []
  const invalid = []
  let mask = false
  if (form) {
    for (const [name, value] of form.entries()) {
      const key = String(name).toLowerCase()
      if (/^(?:image|images)(?:\[\d*\])?$/.test(key)) images.push(value)
      else if (/^mask(?:\[\d*\])?$/.test(key)) mask = true
      else if (typeof value === "string") fields[key] = value
    }
  } else if (json && typeof json === "object" && !Array.isArray(json)) {
    const extra = objectOf(json.extra_body)
    fields.model = json.model ?? extra.model
    fields.prompt = json.prompt ?? extra.prompt
    fields.n = json.n ?? extra.n
    fields.size = json.size ?? extra.size
    fields.ratio = json.ratio ?? extra.ratio
    fields.response_format = json.response_format ?? extra.response_format
    fields.return_base64 = json.return_base64 ?? extra.return_base64
    for (const key of ["image", "images", "image[]", "images[]"]) {
      imageStrings(json[key], images, invalid)
      imageStrings(extra[key], images, invalid)
    }
    mask = json.mask != null || extra.mask != null
  } else {
    return badRequest("the request isn't a JSON object", "invalid_json")
  }

  if (invalid.length) return badRequest("image is not a URL, data URI, or base64 image", "image")
  const model = normalizeModel(fields.model)
  const prompt = typeof fields.prompt === "string" ? fields.prompt.trim() : ""
  if (!model) return badRequest("model is required", "model")
  if (!prompt) return badRequest("prompt is required", "prompt")
  if (!images.length) return badRequest("an edit needs the image to edit", "image")

  const n = normalizeN(fields.n)
  const size = normalizeSize(fields.size, "1024x1024")
  const format = requestedFormat(
    { response_format: fields.response_format, return_base64: fields.return_base64 },
    {},
  )
  const requested = {
    endpoint: "edits",
    originalModel: String(fields.model),
    model,
    prompt,
    n,
    size,
    ratio: normalizeRatio(fields.ratio),
    responseFormat: format,
    images: [],
    maskIgnored: mask,
    via: "edits",
  }

  const allFiles = images.every((value) => value instanceof Blob)
  if (allFiles && n === 1) {
    const native = await runNativeEdits({ requested, images, fetchImpl, base, headers, signal, now })
    if (native.response) return native.response
    if (!native.fallback) return native.error
  }

  const references = []
  for (const value of images) references.push(await toReference(value))
  if (references.some((value) => !value)) {
    return badRequest("an image is not a URL, data URI, or file", "image")
  }
  requested.images = references
  requested.via = allFiles ? "generations-fallback" : "generations"
  return await runGenerations({ requested, fetchImpl, base, headers, signal, now })
}

async function runNativeEdits({ requested, images, fetchImpl, base, headers, signal, now }) {
  const form = new FormData()
  form.set("model", requested.model)
  form.set("prompt", requested.prompt)
  form.set("n", "1")
  form.set("size", requested.size)
  if (requested.responseFormat) form.set("response_format", requested.responseFormat)
  const single = images.length === 1
  for (const [index, image] of images.entries()) {
    const type = image.type || "image/png"
    const name = image.name || `image-${index}.${extensionOf(type)}`
    form.append(single ? "image" : "image[]", image, name)
  }

  const outgoing = new Headers(headers)
  outgoing.delete("content-type")
  outgoing.delete("content-length")
  outgoing.set("accept", "application/json")

  let res
  let text
  let json
  try {
    res = await fetchImpl(`${base}/images/edits`, { method: "POST", headers: outgoing, body: form, signal })
    text = await res.text()
    try {
      json = JSON.parse(text)
    } catch {}
  } catch (error) {
    if (abortLike(error) || signal?.aborted) throw error
    return { error: errorResponse(502, error?.message ?? String(error), "upstream_error") }
  }
  if (res.ok) {
    if (json && Array.isArray(json.data) && json.data.length) {
      return { response: await finishImages({ requested, responses: [json], fetchImpl, signal, now }) }
    }
    const message = json?.error?.message || "Agnes returned no images"
    return { error: errorResponse(502, message, "upstream_error") }
  }
  if (FALLBACK_EDIT_STATUSES.has(res.status) || res.status >= 500) return { fallback: true }
  return { error: await upstreamError(res, text) }
}

async function runGenerations({ requested, fetchImpl, base, headers, signal, now, extraIn = {} }) {
  const extra = { ...extraIn }
  for (const key of ["image", "images", "images[]", "image[]", "ratio", "response_format", "return_base64", "n", "size"]) {
    delete extra[key]
  }
  if (requested.images.length) extra.image = requested.images
  if (requested.responseFormat) extra.response_format = requested.responseFormat

  const body = { model: requested.model, prompt: requested.prompt, size: requested.size }
  if (requested.ratio) body.ratio = requested.ratio
  if (Object.keys(extra).length) body.extra_body = extra
  if (requested.responseFormat === "b64_json" && !requested.images.length) body.return_base64 = true

  const responses = []
  let failure = null
  for (let index = 0; index < requested.n; index++) {
    const result = await postJson(fetchImpl, `${base}/images/generations`, body, headers, signal)
    if (result.error) {
      failure = result.error
      break
    }
    if (!result.res.ok) {
      failure = await upstreamError(result.res, result.text)
      break
    }
    if (!result.json || !Array.isArray(result.json.data) || !result.json.data.length) {
      failure = errorResponse(502, "Agnes returned no images", "upstream_error")
      break
    }
    responses.push(result.json)
  }
  if (!responses.length) return failure ?? errorResponse(502, "Agnes returned no images", "upstream_error")
  // Images already generated and billed are returned even when a later one
  // fails; warnings and x-agnes-partial make the shortfall visible.
  requested.partial = responses.length < requested.n
  return await finishImages({ requested, responses, fetchImpl, signal, now })
}

async function postJson(fetchImpl, url, body, headers, signal) {
  const outgoing = new Headers(headers)
  outgoing.delete("content-length")
  outgoing.set("content-type", "application/json")
  outgoing.set("accept", "application/json")
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: outgoing,
      body: JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {}
    return { res, text, json }
  } catch (error) {
    if (abortLike(error) || signal?.aborted) throw error
    return { error: errorResponse(502, error?.message ?? String(error), "upstream_error") }
  }
}

async function finishImages({ requested, responses, fetchImpl, signal, now }) {
  const first = responses[0]
  const merged = {
    ...first,
    data: responses.flatMap((response) => (Array.isArray(response.data) ? response.data : [])),
  }
  const headers = { "x-agnes-via": requested.via }
  const warnings = []
  if (requested.maskIgnored) {
    headers["x-agnes-mask-ignored"] = "true"
    warnings.push("mask is not supported and was ignored")
  }
  if (requested.partial) {
    headers["x-agnes-partial"] = "true"
    warnings.push("Agnes returned fewer images than requested")
  }

  let dropped = 0
  let data = []
  for (const item of merged.data) {
    const entry = await normalizeImageItem(item, requested, fetchImpl, signal)
    if (entry.inlineFailed) delete entry.inlineFailed
    if (!entry.url && !entry.b64_json) {
      dropped++
      continue
    }
    data.push(entry)
  }
  if (dropped) {
    headers["x-agnes-empty-items"] = String(dropped)
    warnings.push("Agnes returned images without a url or b64_json")
  }
  if (!data.length) return errorResponse(502, "Agnes returned no images", "upstream_error")

  if (requested.responseFormat === "b64_json") {
    const missing = data.filter((entry) => !entry.b64_json)
    if (missing.length) {
      if (missing.length === data.length) {
        return errorResponse(
          502,
          "Agnes generated an image but it could not be downloaded for b64_json",
          "inline_failed",
        )
      }
      data = data.filter((entry) => entry.b64_json)
      headers["x-agnes-b64-missing"] = String(missing.length)
      warnings.push("some images could not be downloaded for b64_json")
    }
  }
  if (!data.length) return errorResponse(502, "Agnes returned no images", "upstream_error")

  const created = Number(merged.created)
  const stamp = Number.isFinite(created) && created > 0 ? created : Math.floor(now() / 1000)
  const body = { ...merged, created: stamp, model: merged.model ?? requested.originalModel, data }
  if (warnings.length) body.warnings = warnings
  return jsonResponse(body, 200, headers)
}

async function normalizeImageItem(item, requested, fetchImpl, signal) {
  let entry
  if (typeof item === "string") {
    entry = /^data:image\//i.test(item) ? dataUriEntry(item) : { url: item }
  } else if (item && typeof item === "object") {
    entry = { ...item }
    if (typeof entry.url === "string" && /^data:image\//i.test(entry.url) && !entry.b64_json) {
      Object.assign(entry, dataUriEntry(entry.url))
    }
    if (entry.b64_json && !entry.mime_type) entry.mime_type = sniffBase64(entry.b64_json)
  } else {
    entry = {}
  }

  if (requested.responseFormat === "b64_json" && entry.url && !entry.b64_json) {
    try {
      const { bytes, mime } = await downloadImage(entry.url, fetchImpl, signal)
      entry.b64_json = base64Of(bytes)
      entry.mime_type = mime
    } catch (error) {
      if (abortLike(error) || signal?.aborted) throw error
      entry.inlineFailed = true
    }
  }
  if (entry.revised_prompt == null) entry.revised_prompt = requested.prompt
  return entry
}

function dataUriEntry(uri) {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/is.exec(uri)
  if (!match) return { url: uri }
  const mime = match[1] || "image/png"
  const base64 = /;base64,/i.test(uri) ? match[2] : null
  return { url: uri, ...(base64 ? { b64_json: base64, mime_type: mime } : { mime_type: mime }) }
}

async function downloadImage(url, fetchImpl, signal) {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol) || privateHost(parsed.hostname)) {
    throw new Error("unsafe image url")
  }
  const timeout = AbortSignal.timeout(60000)
  const combined = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout
  const res = await fetchImpl(url, {
    signal: combined,
    redirect: "error",
    headers: { accept: "image/*" },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const contentType = String(res.headers.get("content-type") ?? "").toLowerCase()
  if (contentType && !/^image\//.test(contentType) && !/^application\/octet-stream/.test(contentType)) {
    throw new Error(`not an image: ${contentType}`)
  }
  const declared = Number(res.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new Error("image too large")
  const bytes = await readCapped(res, MAX_IMAGE_BYTES)
  const mime = detectImageMime(bytes)
  if (!mime) throw new Error("not an image")
  return { bytes, mime }
}

async function readCapped(res, limit) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length > limit) throw new Error("image too large")
    return bytes
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) {
        try {
          await reader.cancel()
        } catch {}
        throw new Error("image too large")
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

function privateHost(hostname) {
  const host = String(hostname ?? "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (!host) return true
  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fe80:")) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length)
    return mapped.includes(":") ? true : privateV4(mapped)
  }
  return privateV4(host)
}

function privateV4(host) {
  const parts = host.split(".")
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false
  const [a, b] = parts.map(Number)
  if ([a, b].some((part) => part > 255)) return false
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

async function upstreamError(res, text) {
  let json
  try {
    json = JSON.parse(text)
  } catch {}
  if (json?.error) return jsonResponse(json, res.status)
  const message = json?.detail || json?.message || String(text ?? "").trim().slice(0, 1000) || `Agnes returned HTTP ${res.status}`
  return errorResponse(res.status, message, String(res.status), "", res.status >= 500 ? "upstream_error" : "invalid_request_error")
}

function badRequest(message, param = "") {
  return errorResponse(400, message, "invalid_request", param, "invalid_request_error")
}

function errorResponse(status, message, code = "", param = "", type = status >= 500 ? "upstream_error" : "invalid_request_error") {
  return jsonResponse(
    { error: { message: String(message), type, param, code: String(code || status) } },
    status,
  )
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

async function toReference(value) {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer())
    const type = String(value.type || "")
    const mime = /^image\//i.test(type) ? type : detectImageMime(bytes) || "image/png"
    return `data:${mime};base64,${base64Of(bytes)}`
  }
  return imageString(value)
}

function objectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function urlOf(input) {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input ?? "")
}

function defaultKeyOf(auth) {
  if (auth?.type === "api" && typeof auth.key === "string") return auth.key.trim()
  if (auth?.type === "oauth" && typeof auth.access === "string") return auth.access.trim()
  return ""
}

async function textOf(body) {
  if (typeof body === "string") return body
  return new TextDecoder().decode(await bytesOf(body))
}

async function bytesOf(body) {
  if (body == null) return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  if (body instanceof Request) return new Uint8Array(await body.arrayBuffer())
  if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer())
  return new TextEncoder().encode(String(body))
}

function base64Of(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64")
  let text = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(text)
}

function base64Bytes(text) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"))
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

function sniffBase64(value) {
  try {
    return sniffImageMime(base64Bytes(String(value).slice(0, 32)))
  } catch {
    return "image/png"
  }
}

function detectImageMime(bytes) {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp"
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (brand === "avif" || brand === "avis") return "image/avif"
  }
  return ""
}

function sniffImageMime(bytes) {
  return detectImageMime(bytes) || "image/png"
}

function abortLike(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError"
}

function extensionOf(mime) {
  if (mime === "image/jpeg") return "jpg"
  if (mime === "image/webp") return "webp"
  if (mime === "image/gif") return "gif"
  return "png"
}
