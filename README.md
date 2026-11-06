# agnes-sakiko

Unofficial Sakiko fork of the Agnes AI plugin for
[OpenCode](https://opencode.ai) and [magpie](https://usemagpie.ai). The plugin
uses Agnes's OpenAI-compatible endpoint at `https://apihub.agnes-ai.com/v1`,
discovers the account's text and image models, and reads both Token Plan and
Agent Plan usage. Its primary sign-in opens the official Agnes login in a
private Chrome window and finishes without asking for your password or a
copied token.

**Provider id:** `agnes-sakiko`

This is a standalone personal fork maintained at
`Sakiko15/agnes-auth`. It is not published under the official
`@magpie-community` scope, is not in magpie's registry, and has no
`magpie-plugin` topic, so magpie's GitHub Discover does not list it. It is not
affiliated with Agnes AI or magpie.

This package targets the **international site**: `platform.agnes-ai.com` and
`apihub.agnes-ai.com`. The CN site would need its own package and provider id,
for example `agnes-cn`.

## Sign-in

### Browser sign-in

Choose one of the browser sign-in methods:

- **Agnes browser sign-in (plan key)** for a Token Plan or Agent Plan key.
- **Agnes browser sign-in (personal key)** for a `default` profile key.
- **Agnes browser sign-in (enterprise key)** for an `enterprise` profile key.

The plugin starts a separate Chrome, Edge, Chromium or Brave profile, opens
the official Agnes login page, and waits for you to sign in. It then reads the
session through Chrome DevTools Protocol, reveals the selected profile's API
key, and closes the browser window.

The dedicated profile is kept at
`~/.config/magpie/agnes-sakiko-browser` (`AGNES_SAKIKO_PROFILE` overrides it),
so the next sign-in can reuse the login instead of asking again. It is
separate from your everyday browser profile; the plugin does not read your
normal cookies, saved passwords or history. The profile is created with mode
`0700`, but it does contain the Agnes session because Chrome keeps it there.

The API key and console session are also stored in the plugin account. Set
`AGNES_SAKIKO_BROWSER` to a Chromium-based browser path if it is outside the
usual locations.

Browser accounts are labeled `Agnes Plan`, `Agnes Personal` or
`Agnes Enterprise`; the account's email or username is not written into
Magpie's plugin auth file.

Personal and enterprise keys are billed from the account balance and can use
the free models enabled for that key. If a profile has more than one active
key, the browser sign-in picks the first active key in the platform's list; use
the API-key fallback if you need a specific key.

This browser path is experimental because it relies on Agnes keeping its
current `localStorage.token` login shape.

### API key fallback

There are two credentials:

- **API key** (for example `cpk-…` for a Token Plan key): used for model
  requests. Create or copy it in the Agnes platform's API key page.
- **Console token** (optional): used only to read plan usage. Sign in at
  [platform.agnes-ai.com](https://platform.agnes-ai.com), then copy
  `localStorage.getItem("token")` from the browser console and paste it into
  the plugin's sign-in prompt.

In the fallback, the API key is stored as the account key and the console token
is stored in `metadata.consoleToken`. The plugin sends the console token only
to `platform-backend.agnes-ai.com`; it never sends it to the model API. A
refused console token does not sign the API key out.

The fallback also asks for the key type, so a manually entered personal or
enterprise key does not request plan quota endpoints.

Treat the console token like a password: it grants access to the Agnes account,
not just to usage.

Agnes currently offers no standard OAuth callback for third-party clients, so
the console token has to be pasted manually. It can expire independently of
the API key; sign in again with a fresh token when that happens.

## Models

After sign-in, `GET /v1/models` supplies the account's live list. Video
generation models are left out. In magpie, image models are listed with image
output (see [Image generation](#image-generation)); OpenCode's provider
catalogue stays chat-only, matching the other providers' convention. Image
quotas still appear on the usage card.

The bootstrap and documented text models are:

| Model | Context | Max output | Input |
| --- | ---: | ---: | --- |
| `agnes-3.0-flash` | 512K | 65,536 | text, image URL |
| `agnes-2.5-flash` | 512K | 65,536 | text, image URL |
| `agnes-2.5-pro` | 1M | 65,536 | text, image URL |
| `agnes-2.5-pro-beta` | 1M | 65,536 | text, image URL |

The image model is:

| Model | Output | Input |
| --- | --- | --- |
| `agnes-image-2.5-flash` | image | text, image |

The account's live list may also include `agnes-image-2.1-flash` and
`agnes-image-2.0-flash`; they are listed the same way.

All documented text models support streaming, tools and reasoning. Prices shown by
magpie use Agnes's published list prices in USD per million tokens. During a
promotion or trial, Agnes may bill less; the platform's usage page remains the
source of truth.

## Image generation

The plugin serves both OpenAI-style image endpoints through magpie's gateway:

- `POST /v1/images/generations` (JSON)
- `POST /v1/images/edits` (multipart/form-data)

Agnes's public documentation covers the first only; the second exists in its
live API and takes images as multipart file uploads. The plugin maps both to
what Agnes accepts and normalizes the answer back to OpenAI's shape.

Generations fields:

- `model`: `agnes-image-2.5-flash` (or
  `agnes-sakiko/agnes-image-2.5-flash` in magpie).
- `prompt`.
- `n`: 1–4. Agnes answers one image per request, so the plugin sends the
  request `n` times and merges the results; values above 4 are cut to 4. A
  changed `n` adds a `warnings` entry and `x-agnes-n-capped: true`. If a later
  request fails, images already generated are still returned with
  `x-agnes-partial: true` and a `warnings` entry.
- `size`: `1K`, `2K`, `3K`, `4K`, or a legacy `WxH` size; absent or `auto`
  becomes `2K`.
- `ratio`: `1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `2:3`, `3:2`, `21:9`. Any
  other value is ignored with a `warnings` entry and
  `x-agnes-ratio-ignored: true`.
- `response_format`: `url` or `b64_json` (top-level or
  `extra_body.response_format`; `return_base64` is accepted too).
- `image` / `images`: a public URL, a `data:image/...;base64,...` URI, or an
  array of either, for image-to-image and multi-image composition. The
  plugin sends them as `extra_body.image`.

Output dimensions come from Agnes's fixed native tier/ratio table, not from
an arbitrary `WxH`. For example, `1K` + `1:1` is `1024x1024`, `1K` + `16:9`
is `1312x736`, and `2K` + `16:9` is `2624x1472`; an unsupported `1920x1080`
is normalized to `1312x736`. The plugin forwards `size` and `ratio`
unchanged and never resizes the image. Request `2K` + `16:9` for a larger
asset, then crop or resize downstream if an exact display resolution is
required.

Edits fields: `model`, `prompt`, `n`, `size`, `response_format`, one file in
`image` or several in `image[]`, and optionally `mask`. The plugin forwards a
multipart edit to Agnes's native `/v1/images/edits`. When that backend answers
404, 405, 415, 422 or 5xx (it currently answers 503 `no available server`),
the plugin retries through generations with `extra_body.image`. After a 5xx
the native endpoint is skipped for five minutes, so later edits go straight to
generations; those responses carry `x-agnes-edits-cooldown: true` and a
warning, and the native endpoint is tried again after the cooldown. An edit
with a valid `ratio` goes straight to generations, because the native endpoint
has no ratio input. A native 200 without images is returned as a 502 rather
than re-running the edit, so one request is never billed twice. A JSON edit
whose images are URLs or data URIs, or which puts them in `extra_body.image`,
goes to generations directly.

Ignored: `mask` (Agnes has no mask input; the response carries
`x-agnes-mask-ignored: true` and a `warnings` entry; a `mask` in `extra_body`
is dropped the same way), `quality`, `background`, `output_format`, `user`,
`stream`, `style`, `moderation`, and `partial_images`. When any of the latter
list is set at the top level or in `extra_body`, the plugin drops it and the
response carries `x-agnes-ignored-fields` listing them plus a `warnings`
entry. Other `extra_body` keys are forwarded unchanged. Default values such as
`false`, `0`, `"auto"` and empty strings are not reported. A generation
request that answers HTTP 429 is retried once, honoring `Retry-After` seconds
or an HTTP date up to five seconds, or waiting 500 ms when the header is
missing; the retry adds `x-agnes-retried: true` and a warning. Responses are
normalized to `{created, data, model}`; `revised_prompt` is filled in when
missing, and a URL is downloaded and returned as `b64_json` when base64 was
asked for. The download rejects private hosts, redirects, non-image content
and files over 25 MiB; that limit also applies to data-URI and base64 inputs
and to multipart edit files. If every requested base64 image fails to download,
the request fails with 502; if only some fail, the successful ones are returned
with `x-agnes-b64-missing` and a warning.

Extra response headers: `x-agnes-via` (`generations`, `edits`, or
`generations-fallback`), `x-agnes-partial` (some of `n` failed),
`x-agnes-empty-items` (answer entries without a URL or base64 data),
`x-agnes-b64-missing` (see above), `x-agnes-n-capped` (the request's `n` was
changed), `x-agnes-ratio-ignored`, `x-agnes-ignored-fields`,
`x-agnes-edits-cooldown` (native edits skipped after a 5xx), and
`x-agnes-retried` (one retry after HTTP 429). Image responses, including most
error responses, carry these headers and the matching JSON `warnings`; an
unexpected internal exception may not.

magpie's **Settings → Models → Image models** may not list
`agnes-image-2.5-flash`: the host recognizes a fixed set of image model names.
Calling the endpoint with `model: "agnes-sakiko/agnes-image-2.5-flash"` works.

```sh
# text-to-image through magpie's gateway
curl -s http://127.0.0.1:3425/v1/images/generations \
  -H 'content-type: application/json' \
  -d '{"model":"agnes-sakiko/agnes-image-2.5-flash","prompt":"a red circle","size":"2K","ratio":"16:9"}'

# image edit through magpie's gateway
curl -s http://127.0.0.1:3425/v1/images/edits \
  -F model=agnes-sakiko/agnes-image-2.5-flash \
  -F prompt='make it blue' \
  -F image=@input.png
```

## Usage

The usage card supports both Agnes plans:

- **Token Plan** (`/api/user/subscription`): text requests in the 5-hour and
  weekly windows, daily image count and daily video seconds.
- **Agent Plan** (`/api/user/agentplan/subscription` and `/credits`): monthly
  Credits, the shared 5-hour Credits window and purchased Credits balance.
- **Personal / enterprise keys** (`/api/user/balance`): the available USD
  balance only. Their model calls are billed from that balance.

An account holding both plans sees both sets of windows. The usage endpoints
are Agnes platform interfaces rather than the public inference API, so a
future upstream change may require a plugin update.

Only accounts signed in with a **plan key** query Token Plan/Agent Plan
usage. **Personal** and **enterprise** accounts show only the wallet balance.
Plan-key accounts do not show the wallet balance.

## Install

From GitHub:

```sh
magpie plugin add github:Sakiko15/agnes-auth
magpie plugin login agnes-sakiko
magpie provider test agnes-sakiko
```

In OpenCode, add the GitHub package (or `@sakiko15/agnes-auth` if you
publish it under that name) under `plugin`, then run `opencode auth login`.

This repository deliberately has no `magpie-plugin` topic, so it does not
appear in magpie's GitHub Discover. Do not add that topic or submit it to the
official registry unless you want it listed.

## Development

```sh
bun test
```

The image transport has an opt-in live test; it sends real image requests and
never prints the key:

```sh
AGNES_SAKIKO_API_KEY=... npm run test:images
```

MIT. Not affiliated with Agnes AI.
