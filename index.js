/**
 * Agnes image and video generation tools.
 *
 * Registers three model-facing tools that call the Agnes AI HTTP API and write
 * the generated media into the calling Session's workspace:
 *
 * - `agnes_image` 鈥?text-to-image, saved as PNG, and additionally published as a
 *   durable image attachment when the bytes fit the attachment admission limits.
 * - `agnes_video` 鈥?text-to-video; creates the asynchronous task and waits.
 * - `agnes_video_status` 鈥?resumes a task `agnes_video` handed back and
 *   downloads the finished file.
 *
 * The package imports nothing from the harness. Tool definitions are raw JSON
 * Schema handed straight to `ctx.tools.register`, so it needs no build step and
 * no peer dependency on any `@deepseek-ai/*` package: it runs from a `file:`
 * install in a profile exactly as written.
 *
 * @module dsh-agnes-media
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Stable Loader identity. */
export const name = 'agnes-media'

/**
 * Services this plugin consumes. `tools` receives the registrations,
 * `credentials` resolves the API key per request, and `fs` locates the Session
 * workspace so generated media lands beside the Session's other files.
 */
export const inject = ['tools', 'credentials', 'fs']

/** Retry attempts per HTTP call: the provider documents 429 and 5xx as retryable. */
const HTTP_ATTEMPTS = 5

/** Video task states the provider reports as settled and usable. */
const DONE_STATES = new Set(['completed', 'succeeded', 'success'])

/** Video task states the provider reports as settled and failed. */
const FAILED_STATES = new Set(['failed', 'error', 'cancelled', 'canceled'])

/** Largest frame count the video model accepts. */
const MAX_FRAMES = 441

/** Largest render wait one call may request, in seconds. */
const MAX_WAIT_SECONDS = 540

/**
 * Slack between this plugin's own HTTP deadline and the deadline it declares to
 * the tool registry, so the plugin's descriptive error wins over the guard's
 * generic one whenever its budget is the binding constraint.
 */
const TOOL_TIMEOUT_MARGIN_MS = 60000

/**
 * Deployment-varying values, each overridable from the composition row.
 *
 * `requestTimeoutMs` bounds one HTTP attempt; `operationDeadlineMs` bounds the
 * whole retry sequence, so a series of attempts can never outlive the caller's
 * patience. The provider documents image and video generation as taking seconds
 * to tens of seconds and recommends a client timeout well above that.
 */
const DEFAULTS = {
  baseURL: 'https://apihub.agnes-ai.com/v1',
  videoStatusURL: 'https://apihub.agnes-ai.com/agnesapi',
  apiKeyEnv: 'AGNES_API_KEY',
  imageModel: 'agnes-image-2.5-flash',
  videoModel: 'agnes-video-v2.0',
  pollIntervalMs: 5000,
  maxMediaBytes: 128 * 1024 * 1024,
  maxInputImageBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 300000,
  operationDeadlineMs: 360000,
  retryStepMs: 4000,
}

/**
 * Read one positive finite number configuration value.
 * @param config - the raw row configuration.
 * @param key - the field to read.
 * @param fallback - the default applied when the field is absent.
 * @returns the configured value, or the default.
 * @throws when a supplied value is not a positive finite number.
 */
function positiveNumber(config, key, fallback) {
  const value = config[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`agnes-media: config "${key}" must be a positive number`)
  }
  return value
}

/**
 * Read one non-empty string configuration value.
 * @param config - the raw row configuration.
 * @param key - the field to read.
 * @param fallback - the default applied when the field is absent.
 * @returns the configured value, or the default.
 * @throws when a supplied value is not a non-empty string.
 */
function nonEmptyString(config, key, fallback) {
  const value = config[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`agnes-media: config "${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Validate one composition row into the settings the tools run with. Every field
 * is optional; a supplied field of the wrong type fails at load rather than at
 * the first model call.
 * @param config - the raw row configuration.
 * @returns the resolved settings.
 */
function readConfig(config) {
  const raw = config ?? {}
  const baseURL = nonEmptyString(raw, 'baseURL', DEFAULTS.baseURL).replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseURL)) throw new Error('agnes-media: config "baseURL" must be an http(s) URL')
  const videoStatusURL = nonEmptyString(raw, 'videoStatusURL', DEFAULTS.videoStatusURL).replace(/\/+$/, '')
  if (!/^https?:\/\//.test(videoStatusURL)) throw new Error('agnes-media: config "videoStatusURL" must be an http(s) URL')
  return {
    baseURL,
    videoStatusURL,
    apiKeyEnv: nonEmptyString(raw, 'apiKeyEnv', DEFAULTS.apiKeyEnv),
    imageModel: nonEmptyString(raw, 'imageModel', DEFAULTS.imageModel),
    videoModel: nonEmptyString(raw, 'videoModel', DEFAULTS.videoModel),
    pollIntervalMs: positiveNumber(raw, 'pollIntervalMs', DEFAULTS.pollIntervalMs),
    maxMediaBytes: positiveNumber(raw, 'maxMediaBytes', DEFAULTS.maxMediaBytes),
    maxInputImageBytes: positiveNumber(raw, 'maxInputImageBytes', DEFAULTS.maxInputImageBytes),
    requestTimeoutMs: positiveNumber(raw, 'requestTimeoutMs', DEFAULTS.requestTimeoutMs),
    operationDeadlineMs: positiveNumber(raw, 'operationDeadlineMs', DEFAULTS.operationDeadlineMs),
    retryStepMs: positiveNumber(raw, 'retryStepMs', DEFAULTS.retryStepMs),
  }
}

/**
 * Resolve the configured credential reference for one operation. Resolution is
 * per call, so a key changed in the Models page reaches the next request without
 * a restart.
 * @param ctx - the plugin context.
 * @param settings - the resolved settings.
 * @returns the bearer token.
 * @throws when the reference is unconfigured.
 */
async function apiKey(ctx, settings) {
  const resolved = await ctx.credentials.resolve(settings.apiKeyEnv)
  if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value.length === 0) {
    throw new Error(`agnes-media: credential "${settings.apiKeyEnv}" is not configured. Store the Agnes API key in Models settings, or set it in the harness credentials file.`)
  }
  return resolved.value
}

/**
 * Render one HTTP failure, preferring the provider's own error message and
 * falling back to the raw body so a non-JSON failure still names itself.
 * @param status - the HTTP status.
 * @param text - the response body.
 * @returns the message to surface to the model.
 */
function httpFailure(status, text) {
  let detail = text.slice(0, 400)
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message.length > 0) detail = message
  } catch {
    // A non-JSON body is already the best available detail.
  }
  return `agnes-media: HTTP ${status}: ${detail}`
}

/**
 * Run one HTTP request, retrying what the provider documents as retryable: rate
 * limits (429) and server errors (5xx) always, transport failures only when the
 * call is idempotent. One operation carries a total deadline as well as a
 * per-attempt timeout, so a retry sequence cannot run away.
 * @param url - the absolute request URL.
 * @param headers - request headers.
 * @param init - `fetch` options other than `headers` and `signal`.
 * @param signal - caller cancellation, when the call has one.
 * @param settings - the resolved settings, which carry the timeout budget.
 * @param options - `retryTransport: false` for a non-idempotent call whose first
 *   attempt may already have taken effect: its transport failure is reported
 *   instead of repeated, so one submitted video never becomes two tasks.
 * @returns the settled response, including non-2xx ones this policy does not retry.
 * @throws when every attempt failed, the budget ran out, or the caller cancelled.
 */
async function request(url, headers, init, signal, settings, options = {}) {
  const retryTransport = options.retryTransport !== false
  const deadline = Date.now() + settings.operationDeadlineMs
  let lastFailure = 'agnes-media: no attempt was made'
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      const backoff = settings.retryStepMs * (attempt - 1)
      if (Date.now() + backoff >= deadline) break
      await new Promise(resolve => setTimeout(resolve, backoff))
    }
    signal?.throwIfAborted()
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timeout = AbortSignal.timeout(Math.min(settings.requestTimeoutMs, remaining))
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      const response = await fetch(url, { ...init, headers, signal: composed })
      if (response.status !== 429 && response.status < 500) return response
      lastFailure = httpFailure(response.status, await response.text())
    } catch (error) {
      if (signal?.aborted === true) throw error
      const detail = error instanceof Error ? error.message : String(error)
      if (!retryTransport) {
        throw new Error(`agnes-media: ${detail} 鈥?this call is not idempotent, so it is not retried; check the provider for a task it may already have created`)
      }
      lastFailure = `agnes-media: network error: ${detail}`
    }
  }
  throw new Error(`${lastFailure} (retry budget of ${settings.operationDeadlineMs}ms exhausted)`)
}

/**
 * Run one JSON request and decode its body.
 * @param url - the absolute request URL.
 * @param headers - request headers.
 * @param init - `fetch` options other than `headers` and `signal`.
 * @param signal - caller cancellation, when the call has one.
 * @param settings - the resolved settings, which carry the timeout budget.
 * @param options - retry policy, forwarded to {@link request}.
 * @returns the decoded response body.
 * @throws when the response is an error, or its body is not JSON.
 */
async function requestJson(url, headers, init, signal, settings, options) {
  const response = await request(url, headers, init, signal, settings, options)
  const text = await response.text()
  if (!response.ok) throw new Error(httpFailure(response.status, text))
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`agnes-media: expected JSON, received: ${text.slice(0, 200)}`)
  }
}

/**
 * Locate the calling Session's workspace as an absolute path.
 * @param ctx - the plugin context.
 * @param exec - the running tool execution.
 * @returns the process path of the Session workspace.
 * @throws when the call has no Session workspace.
 */
async function workspace(ctx, exec) {
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('agnes-media: this tool requires a Session with a workspace')
  }
  return ctx.fs.processPath(await ctx.fs.resolve(cwd))
}

/**
 * Resolve one model-supplied file name inside the Session workspace. A name
 * carrying a directory, an absolute path, or a traversal segment is refused, so
 * the model chooses the file name but never the directory.
 *
 * Both separators are refused on every platform: on POSIX a backslash is an
 * ordinary name character, and accepting it there would produce a file that
 * becomes a directory entry once the workspace reaches a Windows host or share.
 * @param requested - the model-supplied name, when it supplied one.
 * @param fallback - the generated name used when it did not.
 * @returns a bare file name.
 * @throws when the requested name escapes the workspace.
 */
function outputName(requested, fallback) {
  if (requested === undefined || requested === null) return fallback
  if (typeof requested !== 'string') throw new Error('agnes-media: "name" must be a string')
  const trimmed = requested.trim()
  if (trimmed.length === 0) return fallback
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error(`agnes-media: "name" must be a plain file name inside the Session workspace, received "${requested}"`)
  }
  return trimmed
}

/**
 * Read the media payload out of one response record: inline base64, or a public
 * URL downloaded separately.
 * @param item - the provider's result item.
 * @param maxBytes - inclusive byte cap.
 * @param signal - caller cancellation, when the call has one.
 * @returns the media bytes, or `undefined` when the record carries neither form.
 */
async function readPayload(item, maxBytes, signal, settings) {
  let bytes
  if (typeof item?.b64_json === 'string' && item.b64_json.length > 0) {
    bytes = Buffer.from(item.b64_json, 'base64')
  } else if (typeof item?.url === 'string' && item.url.length > 0) {
    const response = await request(item.url, {}, { method: 'GET' }, signal, settings)
    if (!response.ok) throw new Error(`agnes-media: downloading the result answered HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    return undefined
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`agnes-media: the result is ${bytes.byteLength} bytes, over the configured maxMediaBytes of ${maxBytes}`)
  }
  return bytes
}

/**
 * Find the download URL a settled video record carries.
 * @param node - the record, or a nested value of it.
 * @param depth - remaining recursion depth.
 * @returns the URL, or `undefined` when the record carries none.
 */
function findMediaUrl(node, depth) {
  if (depth > 4 || node === null || typeof node !== 'object') return undefined
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && /^https?:\/\//.test(value) && /url|video|output|download|file/i.test(key)) return value
  }
  for (const value of Object.values(node)) {
    const found = findMediaUrl(value, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Media type of one input image, from its file extension.
 * @param path - the Session path the bytes were read from.
 * @returns the media type carried in the Data URI.
 */
function imageMediaType(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/png'
}

/** Big-endian 32-bit read; PNG carries its dimensions that way. */
const uint32be = (bytes, offset) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0

/** ASCII tag at one offset; RIFF containers identify themselves this way. */
const tag = (bytes, offset, text) =>
  text.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0))

/**
 * Dimensions of one encoded image, read from its own header.
 *
 * The four formats the harness accepts are covered; anything else answers
 * `undefined` and the caller keeps its default. Header parsing is enough because
 * only the aspect ratio is wanted 鈥?no decoding, no image library.
 * @param bytes - the encoded image.
 * @returns `{ width, height }`, or `undefined` when the format is unrecognized.
 */
function imageDimensions(bytes) {
  // PNG: signature, then IHDR width and height.
  if (bytes.length >= 24 && bytes[0] === 0x89 && tag(bytes, 1, 'PNG')) {
    return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) }
  }
  // GIF: logical screen descriptor, little-endian 16-bit.
  if (bytes.length >= 10 && tag(bytes, 0, 'GIF')) {
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
  }
  // WebP: RIFF container; VP8X stores canvas minus one, VP8 / VP8L the frame.
  if (bytes.length >= 30 && tag(bytes, 0, 'RIFF') && tag(bytes, 8, 'WEBP')) {
    if (tag(bytes, 12, 'VP8X')) {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      }
    }
    if (tag(bytes, 12, 'VP8 ')) {
      return { width: ((bytes[27] << 8) | bytes[26]) & 0x3fff, height: ((bytes[29] << 8) | bytes[28]) & 0x3fff }
    }
    if (tag(bytes, 12, 'VP8L')) {
      return {
        width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
        height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)),
      }
    }
    return undefined
  }
  // JPEG: walk the marker segments to the first start-of-frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      if (marker === 0xff) {
        offset += 1
        continue
      }
      // Standalone markers carry no length field.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2
        continue
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) {
        return { width: (bytes[offset + 7] << 8) | bytes[offset + 8], height: (bytes[offset + 5] << 8) | bytes[offset + 6] }
      }
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      if (length < 2) return undefined
      offset += 2 + length
    }
  }
  return undefined
}

/** Aspect ratios the image API accepts, in the order the tool documents them. */
const RATIOS = [
  ['1:1', 1],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
  ['21:9', 21 / 9],
]

/**
 * Nearest supported aspect ratio for one input image. Compared in log space, so a
 * portrait and its landscape twin are equidistant rather than one winning by
 * arithmetic accident.
 * @param width - input image width in pixels.
 * @param height - input image height in pixels.
 * @returns the closest ratio label, or `undefined` for a degenerate size.
 */
function nearestRatio(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  const target = Math.log(width / height)
  let best
  let bestDelta = Infinity
  for (const [label, value] of RATIOS) {
    const delta = Math.abs(Math.log(value) - target)
    if (delta < bestDelta) {
      bestDelta = delta
      best = label
    }
  }
  return best
}

/**
 * Resolve one model-supplied input image into what the API accepts. A public
 * URL or an existing Data URI passes through unchanged; a Session path is read
 * through the sandboxed filesystem service 鈥?so the deployment's file policy
 * still applies 鈥?and inlined as a Data URI, which the provider documents as the
 * alternative when an image cannot be made public.
 * @param ctx - the plugin context.
 * @param settings - the resolved settings.
 * @param entry - the model-supplied path or URL.
 * @param cwd - the Session workspace, used to resolve relative paths.
 * @param signal - caller cancellation, when the call has one.
 * @returns the resolved URI, plus the pixel size when a local file revealed it.
 * @throws when the entry is empty, or the file cannot be read under policy.
 */
async function inputImage(ctx, settings, entry, cwd, signal) {
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    throw new Error('agnes-media: each input image must be a non-empty Session path or URL')
  }
  const value = entry.trim()
  if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) return { uri: value }
  const target = await ctx.fs.resolve(value, { cwd, signal })
  const bytes = await ctx.fs.readBytes(target, signal, settings.maxInputImageBytes)
  const size = imageDimensions(bytes)
  return {
    uri: `data:${imageMediaType(value)};base64,${Buffer.from(bytes).toString('base64')}`,
    ...size === undefined ? {} : size,
  }
}

/**
 * Resolve every model-supplied input image for one call.
 * @param ctx - the plugin context.
 * @param settings - the resolved settings.
 * @param entries - the model-supplied paths or URLs.
 * @param cwd - the Session workspace, used to resolve relative paths.
 * @param signal - caller cancellation, when the call has one.
 * @returns the resolved inputs, in the order given.
 */
async function inputImages(ctx, settings, entries, cwd, signal) {
  const resolved = []
  for (const entry of entries) resolved.push(await inputImage(ctx, settings, entry, cwd, signal))
  return resolved
}

/**
 * Aspect ratio to redraw an input image at: the first resolved input that
 * revealed its own size decides, and a call with only URLs or Data URIs keeps
 * the caller's default because nothing here may download them.
 * @param inputs - the resolved inputs, in the order given.
 * @returns a ratio label, or `undefined` when no input stated its size.
 */
function inputRatio(inputs) {
  for (const input of inputs) {
    const ratio = nearestRatio(input.width, input.height)
    if (ratio !== undefined) return ratio
  }
  return undefined
}

/**
 * Render one provider-reported task failure. A settled task reports `error`
 * either as a string or as the same `{ message, type, code }` object the HTTP
 * error bodies use; the object form must name its message rather than
 * stringify into `[object Object]`.
 * @param error - the record's `error` field.
 * @returns the failure detail, or `null` when the record reported none.
 */
function providerFailure(error) {
  if (error === null || error === undefined) return null
  if (typeof error === 'string') return error.slice(0, 200)
  if (typeof error === 'object') {
    const message = error.message ?? error.type ?? error.code
    if (typeof message === 'string' && message.length > 0) return message.slice(0, 200)
    return JSON.stringify(error).slice(0, 200)
  }
  return String(error).slice(0, 200)
}

/**
 * Publish generated image bytes as a durable attachment so the result renders
 * inline. Attachment admission limits (side length, byte cap) are advisory here:
 * the file on disk is the deliverable and stays valid when the attachment is
 * refused, so a refusal is logged and the call still succeeds.
 * @param ctx - the plugin context.
 * @param bytes - the encoded PNG.
 * @param fileName - the display name.
 * @returns the image content block, or `undefined` when nothing was stored.
 */
async function inlineImage(ctx, bytes, fileName) {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return undefined
  try {
    const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: fileName })
    return {
      type: 'image',
      attachment: {
        attachmentId: String(ref.attachmentId),
        mediaType: String(ref.mediaType),
        bytes: Number(ref.bytes),
        width: Number(ref.width),
        height: Number(ref.height),
        name: String(ref.name ?? fileName),
      },
    }
  } catch (error) {
    ctx.logger.warn(`agnes-media: inline attachment skipped 鈥?${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Register the Agnes media tools.
 * @param ctx - the preset-scoped context this row was mounted in.
 * @param config - the composition row configuration.
 */
export function apply(ctx, config) {
  const settings = readConfig(config)

  ctx.tools.register({
    name: 'agnes_image',
    timeoutMs: settings.operationDeadlineMs + TOOL_TIMEOUT_MARGIN_MS,
    description: 'Generate an image from a text prompt with the Agnes image model and save it as a PNG file in the Session workspace. '
      + 'Pass `images` to transform existing pictures instead: one input is image-to-image, several compose them together. '
      + 'Returns the absolute file path, byte size, and 鈥?when the image fits the attachment limits 鈥?the image itself. '
      + 'The provider queues requests and may answer 503 for a full queue or 429 on a free tier; this tool already retries those, so a slow call is normal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What to draw, or how to transform the input images. Describe subject, scene, style, lighting and composition.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Input images for image-to-image or multi-image composition: Session file paths (absolute, or relative to the workspace) or public URLs. '
            + 'One entry redraws that image; several compose them together. Omit entirely for text-to-image.',
        },
        size: { type: 'string', description: "Output tier: '1K', '2K', '3K' or '4K'; a legacy exact size such as '1024x768' is also accepted. Default '2K'." },
        ratio: { type: 'string', description: "Aspect ratio used with a tier size: '1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2' or '21:9'. Default '3:4'." },
        name: { type: 'string', description: "Output file name ending in .png. Default 'agnes-image-<timestamp>.png'." },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          model: { type: 'string' },
          size: { type: 'string' },
          ratio: { type: 'string' },
          revisedPrompt: { description: 'The provider-rewritten prompt, or null when it returned none.' },
          inline: { description: 'Image content block published as a durable attachment, absent when it was not stored.' },
        },
      },
      render(_args, value) {
        const blocks = [{ type: 'text', text: `agnes_image 鈫?${value.path} (${value.bytes} bytes, ${value.size} ${value.ratio})` }]
        if (value.inline !== undefined) blocks.push(value.inline)
        return blocks
      },
    },
    async execute(args, exec) {
      const size = typeof args.size === 'string' && args.size.length > 0 ? args.size : '2K'
      const fileName = outputName(args.name, `agnes-image-${Date.now()}.png`)
      const directory = await workspace(ctx, exec)
      const key = await apiKey(ctx, settings)
      const requested = Array.isArray(args.images) ? args.images : []
      // A redraw keeps the input's own framing unless the caller chose one:
      // defaulting to a fixed ratio re-composes a picture the caller asked to keep.
      const inputs = requested.length === 0 ? [] : await inputImages(ctx, settings, requested, directory, exec.signal)
      const stated = typeof args.ratio === 'string' && args.ratio.length > 0 ? args.ratio : undefined
      const ratio = stated ?? inputRatio(inputs) ?? '3:4'
      const body = { model: settings.imageModel, prompt: args.prompt, size, ratio, return_base64: true }
      if (inputs.length > 0) body.extra_body = { image: inputs.map(input => input.uri) }
      const parsed = await requestJson(
        `${settings.baseURL}/images/generations`,
        { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        { method: 'POST', body: JSON.stringify(body) },
        exec.signal,
        settings,
      )
      const item = parsed?.data?.[0]
      if (item === undefined) throw new Error('agnes-media: the image response carried no data entry')
      const bytes = await readPayload(item, settings.maxMediaBytes, exec.signal, settings)
      if (bytes === undefined) throw new Error('agnes-media: the image response carried neither base64 data nor a URL')
      const target = join(directory, fileName)
      await writeFile(target, bytes)
      const inline = await inlineImage(ctx, bytes, fileName)
      return {
        path: target,
        bytes: bytes.byteLength,
        model: settings.imageModel,
        size,
        ratio,
        revisedPrompt: typeof item.revised_prompt === 'string' && item.revised_prompt.length > 0 ? item.revised_prompt : null,
        ...(inline === undefined ? {} : { inline }),
      }
    },
  })

  /**
   * Create or resume one video task, poll it, and download it once it settles.
   * @param job - the task identity, its output location, and the polling budget.
   * @returns the model-facing result, settled or still rendering.
   */
  async function runVideo(job) {
    const headers = { authorization: `Bearer ${await apiKey(ctx, settings)}`, 'content-type': 'application/json' }
    let record
    let videoId = job.videoId
    if (videoId === undefined) {
      // Creating a task is not idempotent: a transport failure leaves the outcome
      // unknown, and repeating it would bill and queue a second render. Only a
      // response the provider actually sent is retried here.
      record = await requestJson(
        `${settings.baseURL}/videos`,
        headers,
        { method: 'POST', body: JSON.stringify(job.body) },
        job.signal,
        settings,
        { retryTransport: false },
      )
      const id = record?.video_id ?? record?.id ?? record?.task_id
      if (typeof id !== 'string' || id.length === 0) throw new Error('agnes-media: the video response carried no video_id')
      videoId = id
    }
    let status = typeof record?.status === 'string' ? record.status : 'queued'
    const deadline = Date.now() + job.waitMs
    while (!DONE_STATES.has(status) && !FAILED_STATES.has(status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, settings.pollIntervalMs))
      job.signal?.throwIfAborted()
      record = await requestJson(
        `${settings.videoStatusURL}?video_id=${encodeURIComponent(videoId)}`,
        headers,
        { method: 'GET' },
        job.signal,
        settings,
      )
      if (typeof record?.status === 'string') status = record.status
    }
    const progress = typeof record?.progress === 'number' ? record.progress : null
    const providerError = providerFailure(record?.error)
    if (!DONE_STATES.has(status)) return { ok: false, videoId, status, progress, path: null, bytes: null, error: providerError }
    const url = findMediaUrl(record, 0)
    if (url === undefined) throw new Error('agnes-media: the task completed but its record carried no download URL')
    const bytes = await readPayload({ url }, settings.maxMediaBytes, job.signal, settings)
    if (bytes === undefined) throw new Error('agnes-media: the completed video carried no payload')
    const target = join(job.directory, job.fileName)
    await writeFile(target, bytes)
    return { ok: true, videoId, status, progress, path: target, bytes: bytes.byteLength, error: null }
  }

  const videoOutput = {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        videoId: { type: 'string' },
        status: { type: 'string' },
        progress: { description: 'Provider progress percentage, or null when it reported none.' },
        path: { description: 'Absolute path of the downloaded MP4, or null while the task is unfinished.' },
        bytes: { description: 'Downloaded byte size, or null while the task is unfinished.' },
        error: { description: 'Provider-reported failure detail, or null.' },
      },
    },
    // The registry calls render(arguments, value): the first parameter is the
    // call's arguments and the second the validated execute result.
    render(_args, value) {
      if (value.ok === true) {
        return [{
          type: 'text',
          text: `agnes_video 鈫?${value.path} (${value.bytes} bytes)\nvideo_id ${value.videoId}, status ${value.status}`,
        }]
      }
      const lines = [`video not finished: status ${value.status}${value.progress === null ? '' : `, progress ${value.progress}%`}`]
      if (value.error !== null) lines.push(`provider error: ${value.error}`)
      lines.push(`video_id ${value.videoId}`)
      lines.push('Call agnes_video_status with this video_id to finish and download it.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }

  ctx.tools.register({
    name: 'agnes_video',
    timeoutMs: MAX_WAIT_SECONDS * 1000 + settings.operationDeadlineMs + TOOL_TIMEOUT_MARGIN_MS,
    description: 'Generate a video from a text prompt with the Agnes video model and save it as an MP4 file in the Session workspace. '
      + 'Pass `images` to animate existing pictures instead: one input is image-to-video, several drive a keyframe transition when `mode` is "keyframes". '
      + 'Video generation is asynchronous: this tool creates the task and waits, and when the task is still rendering it returns the video_id for agnes_video_status to finish. '
      + 'The provider allows about one video request per minute and answers 429 beyond that; this tool retries with backoff but a free-tier rate limit can still surface.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'What the video should show, or how the input images should move. Describe motion, camera movement and lighting.' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Input images for image-to-video or keyframe animation: Session file paths (absolute, or relative to the workspace) or public URLs. '
            + 'One entry animates that image; several drive a keyframe transition. Omit entirely for text-to-video.',
        },
        mode: { type: 'string', description: 'Generation mode. Send "keyframes" for a transition across several input images; omit for the default text-to-video or single-image behaviour.' },
        width: { type: 'integer', description: 'Frame width in pixels. Default 1152. The service normalizes to its nearest standard tier.' },
        height: { type: 'integer', description: 'Frame height in pixels. Default 768. The service normalizes to its nearest standard tier.' },
        frames: { type: 'integer', description: 'Frame count; must be 8n+1 and at most 441. 121 at 24fps is about 5 seconds. Default 121.' },
        frameRate: { type: 'number', description: 'Frames per second, 1-60. Default 24.' },
        waitSeconds: { type: 'integer', description: 'How long to wait for the render inside this call, up to 540. Default 240.' },
        name: { type: 'string', description: "Output file name ending in .mp4. Default 'agnes-video-<timestamp>.mp4'." },
      },
      required: ['prompt'],
    },
    output: videoOutput,
    async execute(args, exec) {
      const frames = args.frames ?? 121
      if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES || (frames - 1) % 8 !== 0) {
        throw new Error(`agnes-media: "frames" must be 8n+1 and at most ${MAX_FRAMES}, such as 81, 121, 161, 241 or 441`)
      }
      const waitSeconds = args.waitSeconds === undefined ? 240 : Math.min(args.waitSeconds, MAX_WAIT_SECONDS)
      const directory = await workspace(ctx, exec)
      const inputs = Array.isArray(args.images) ? args.images : []
      const resolved = await inputImages(ctx, settings, inputs, directory, exec.signal)
      const mode = typeof args.mode === 'string' && args.mode.length > 0 ? args.mode : undefined
      const body = {
        model: settings.videoModel,
        prompt: args.prompt,
        width: args.width ?? 1152,
        height: args.height ?? 768,
        num_frames: frames,
        frame_rate: args.frameRate ?? 24,
      }
      if (resolved.length === 1 && mode === undefined) {
        // One image and no explicit mode is the documented image-to-video shape;
        // several images, or any explicit mode, travel as extra_body.
        body.image = resolved[0].uri
      } else if (resolved.length > 0) {
        body.extra_body = { image: resolved.map(input => input.uri), ...(mode === undefined ? {} : { mode }) }
      }
      return runVideo({
        videoId: undefined,
        directory,
        fileName: outputName(args.name, `agnes-video-${Date.now()}.mp4`),
        waitMs: Math.round(waitSeconds * 1000),
        signal: exec.signal,
        body,
      })
    },
  })

  ctx.tools.register({
    name: 'agnes_video_status',
    timeoutMs: MAX_WAIT_SECONDS * 1000 + settings.operationDeadlineMs + TOOL_TIMEOUT_MARGIN_MS,
    description: 'Check an Agnes video task created by agnes_video and, once it has finished, download it into the Session workspace as an MP4. '
      + 'Call this with the video_id that agnes_video returned while the task was still rendering.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        videoId: { type: 'string', description: 'The video_id returned by agnes_video.' },
        waitSeconds: { type: 'integer', description: 'How long to keep polling inside this call, up to 540. Default 120.' },
        name: { type: 'string', description: "Output file name ending in .mp4. Default 'agnes-video-<timestamp>.mp4'." },
      },
      required: ['videoId'],
    },
    output: videoOutput,
    async execute(args, exec) {
      const waitSeconds = args.waitSeconds === undefined ? 120 : Math.min(args.waitSeconds, MAX_WAIT_SECONDS)
      return runVideo({
        videoId: args.videoId,
        directory: await workspace(ctx, exec),
        fileName: outputName(args.name, `agnes-video-${Date.now()}.mp4`),
        waitMs: Math.round(waitSeconds * 1000),
        signal: exec.signal,
        body: undefined,
      })
    },
  })
}
