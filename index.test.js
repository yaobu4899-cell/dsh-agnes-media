/**
 * Tests for the Agnes media plugin.
 *
 * Everything runs against a stubbed `fetch` and a stubbed context, so the suite
 * needs no API key, no network, and no harness. It covers the four regression
 * areas this plugin has actually broken in: configuration validation, output
 * name hygiene, request-body construction (including the image-to-image branch),
 * and the render signature — plus the non-idempotent create rule and the retry
 * budget.
 *
 * Run with:  node --test
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { apply } from './index.js'

// ── encoded-image builders: only the headers the plugin reads ────────────────

/** PNG signature plus an IHDR carrying the dimensions. */
function png(width, height) {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

/** GIF logical screen descriptor. */
function gif(width, height) {
  const bytes = Buffer.alloc(10)
  bytes.write('GIF89a', 0, 'ascii')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

/** JPEG SOI plus a start-of-frame segment. */
function jpeg(width, height) {
  const frame = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame])
}

/** WebP RIFF container with a VP8X canvas header. */
function webp(width, height) {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  const w = width - 1
  const h = height - 1
  bytes[24] = w & 0xff
  bytes[25] = (w >> 8) & 0xff
  bytes[26] = (w >> 16) & 0xff
  bytes[27] = h & 0xff
  bytes[28] = (h >> 8) & 0xff
  bytes[29] = (h >> 16) & 0xff
  return bytes
}

// ── harness ─────────────────────────────────────────────────────────────────

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const binary = bytes => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })

let workspace

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agnes-media-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/**
 * Install the plugin against a stubbed context.
 * @param options - `config`, `handler(url, init, call)` for the stub fetch,
 *   `files` mapping a workspace file name to bytes, and `attachments`.
 * @returns the registered tools, the recorded fetch calls, and a restore hook.
 */
function mount(options = {}) {
  const tools = new Map()
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    if (options.handler === undefined) throw new Error(`unexpected fetch: ${url}`)
    return options.handler(String(url), init, calls.length)
  }
  for (const [name, bytes] of Object.entries(options.files ?? {})) writeFileSync(join(workspace, name), bytes)
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
    get: name => (name === 'attachments' ? options.attachments : undefined),
    logger: { warn: () => {} },
    credentials: {
      resolve: async () => (options.credential === null ? undefined : { value: options.credential ?? 'test-key' }),
    },
    fs: {
      // Mirror the real service: a relative path resolves against the cwd the
      // caller passed, which is what makes `images: ['in.png']` work.
      resolve: async (path, opts) => ({
        targetKey: isAbsolute(path) ? path : join(opts?.cwd ?? workspace, path),
        displayPath: path,
      }),
      readBytes: async (target, _signal, maxBytes) => {
        const bytes = readFileSync(target.targetKey)
        if (bytes.byteLength > maxBytes) throw new Error(`over maxInputImageBytes (${bytes.byteLength})`)
        return bytes
      },
      processPath: () => workspace,
    },
  }
  apply(ctx, options.config)
  return { tools, calls, restore: () => { globalThis.fetch = realFetch } }
}

const exec = () => ({ agent: { session: { header: { cwd: workspace } } } })

/** A handler that answers one image request with inline base64. */
const imageOk = () => json({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64'), revised_prompt: '' }] })

// ── configuration ───────────────────────────────────────────────────────────

describe('configuration', () => {
  const rejects = (config, pattern) => {
    assert.throws(() => apply({ tools: { register: () => () => {} } }, config), pattern)
  }

  test('rejects every malformed field at load time', () => {
    rejects({ baseURL: 'ftp://x' }, /baseURL/)
    rejects({ baseURL: '' }, /baseURL/)
    rejects({ videoStatusURL: 'nope' }, /videoStatusURL/)
    rejects({ apiKeyEnv: '' }, /apiKeyEnv/)
    rejects({ imageModel: 7 }, /imageModel/)
    rejects({ pollIntervalMs: 'soon' }, /pollIntervalMs/)
    rejects({ pollIntervalMs: 0 }, /pollIntervalMs/)
    rejects({ maxMediaBytes: -1 }, /maxMediaBytes/)
    rejects({ maxInputImageBytes: 0 }, /maxInputImageBytes/)
    rejects({ requestTimeoutMs: 'x' }, /requestTimeoutMs/)
    rejects({ operationDeadlineMs: -5 }, /operationDeadlineMs/)
  })

  test('accepts an empty configuration and a fully custom one', () => {
    const bare = mount({ config: undefined, handler: imageOk })
    try {
      assert.ok(bare.tools.has('agnes_image'))
    } finally {
      bare.restore()
    }
    const custom = mount({ config: { baseURL: 'https://example.test/v1' }, handler: imageOk })
    try {
      assert.ok(custom.tools.has('agnes_image'))
    } finally {
      custom.restore()
    }
  })

  test('routes through a custom baseURL', async () => {
    const h = mount({ config: { baseURL: 'https://example.test/v1' }, handler: imageOk })
    try {
      await h.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec())
      assert.equal(h.calls[0].url, 'https://example.test/v1/images/generations')
    } finally {
      h.restore()
    }
  })

  test('fails loudly when the credential is missing', async () => {
    const h = mount({ credential: null, handler: imageOk })
    try {
      await assert.rejects(
        h.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec()),
        /credential "AGNES_API_KEY" is not configured/,
      )
      assert.equal(h.calls.length, 0)
    } finally {
      h.restore()
    }
  })
})

// ── output name hygiene ─────────────────────────────────────────────────────

describe('output name', () => {
  test('refuses a path that could escape the workspace, before any request', async () => {
    const h = mount({ handler: imageOk })
    try {
      // Portable rejections: traversal, either separator, and a non-string.
      const refused = /plain file name|"name" must be a string/
      for (const name of ['../escape.png', 'sub/dir.png', 'sub\\dir.png', 42]) {
        await assert.rejects(
          h.tools.get('agnes_image').execute({ prompt: 'x', name }, exec()),
          refused,
          `expected "${name}" to be refused`,
        )
      }
      assert.equal(h.calls.length, 0)
    } finally {
      h.restore()
    }
  })

  test('names the reason each refusal carries', async () => {
    const h = mount({ handler: imageOk })
    try {
      await assert.rejects(
        h.tools.get('agnes_image').execute({ prompt: 'x', name: 42 }, exec()),
        /"name" must be a string/,
      )
      await assert.rejects(
        h.tools.get('agnes_image').execute({ prompt: 'x', name: 'sub/dir.png' }, exec()),
        /plain file name/,
      )
      assert.equal(h.calls.length, 0)
    } finally {
      h.restore()
    }
  })

  test('refuses a Windows path shape on POSIX, where a backslash is a name character', async () => {
    const h = mount({ handler: imageOk })
    try {
      // basename() treats "\" as a separator only on Windows, so these were
      // accepted on POSIX, where they name one file carrying a separator that
      // becomes a directory entry once the workspace reaches a Windows host.
      for (const name of ['sub\\dir.png', 'C:\\abs.png']) {
        await assert.rejects(
          h.tools.get('agnes_image').execute({ prompt: 'x', name }, exec()),
          /plain file name/,
          `expected "${name}" to be refused on ${process.platform}`,
        )
      }
      assert.equal(h.calls.length, 0)
    } finally {
      h.restore()
    }
  })

  test('trims a plain name and writes exactly that file', async () => {
    const h = mount({ handler: imageOk })
    try {
      const value = await h.tools.get('agnes_image').execute({ prompt: 'x', name: '  out.png  ' }, exec())
      assert.equal(value.path, join(workspace, 'out.png'))
      assert.equal(readFileSync(value.path).toString(), 'PNGDATA')
    } finally {
      h.restore()
    }
  })
})

// ── image request bodies ────────────────────────────────────────────────────

describe('agnes_image request body', () => {
  test('text-to-image carries no extra_body', async () => {
    const h = mount({ handler: imageOk })
    try {
      await h.tools.get('agnes_image').execute({ prompt: 'a cat', name: 'a.png' }, exec())
      const body = h.calls[0].body
      assert.equal(body.extra_body, undefined)
      assert.equal(body.return_base64, true)
      assert.equal(body.ratio, '3:4')
      assert.equal(body.size, '2K')
    } finally {
      h.restore()
    }
  })

  test('a local file becomes a Data URI and a public URL passes through', async () => {
    const h = mount({ files: { 'in.png': png(800, 600) }, handler: imageOk })
    try {
      await h.tools.get('agnes_image').execute(
        { prompt: 'redraw', images: ['in.png', 'https://example.test/b.png'], name: 'a.png' },
        exec(),
      )
      const sent = h.calls[0].body.extra_body.image
      assert.match(sent[0], /^data:image\/png;base64,/)
      assert.equal(sent[1], 'https://example.test/b.png')
    } finally {
      h.restore()
    }
  })

  test('a redraw keeps the input aspect unless the caller states one', async () => {
    const cases = [
      ['wide.png', png(1600, 900), '16:9'],
      ['tall.png', png(900, 1600), '9:16'],
      ['square.png', png(1024, 1024), '1:1'],
      ['photo.jpg', jpeg(1200, 1600), '3:4'],
      ['anim.gif', gif(400, 400), '1:1'],
      ['art.webp', webp(1280, 720), '16:9'],
    ]
    for (const [name, bytes, expected] of cases) {
      const h = mount({ files: { [name]: bytes }, handler: imageOk })
      try {
        await h.tools.get('agnes_image').execute({ prompt: 'redraw', images: [name], name: 'a.png' }, exec())
        assert.equal(h.calls[0].body.ratio, expected, `${name} should redraw at ${expected}`)
      } finally {
        h.restore()
      }
    }
  })

  test('an explicit ratio wins, and a URL-only input keeps the default', async () => {
    const explicit = mount({ files: { 'wide.png': png(1600, 900) }, handler: imageOk })
    try {
      await explicit.tools.get('agnes_image').execute(
        { prompt: 'redraw', images: ['wide.png'], ratio: '1:1', name: 'a.png' },
        exec(),
      )
      assert.equal(explicit.calls[0].body.ratio, '1:1')
    } finally {
      explicit.restore()
    }
    const remote = mount({ handler: imageOk })
    try {
      await remote.tools.get('agnes_image').execute(
        { prompt: 'redraw', images: ['https://example.test/x.png'], name: 'a.png' },
        exec(),
      )
      assert.equal(remote.calls[0].body.ratio, '3:4')
    } finally {
      remote.restore()
    }
  })

  test('an unreadable input is refused', async () => {
    const h = mount({ handler: imageOk })
    try {
      await assert.rejects(h.tools.get('agnes_image').execute({ prompt: 'x', images: ['missing.png'] }, exec()))
      assert.equal(h.calls.length, 0)
    } finally {
      h.restore()
    }
  })
})

// ── video ───────────────────────────────────────────────────────────────────

describe('agnes_video', () => {
  const queued = () => json({ video_id: 'video_1', status: 'queued', size: '1088x832' })

  test('refuses a frame count the model cannot accept, before any request', async () => {
    const h = mount({ handler: queued })
    try {
      for (const frames of [100, 442, 0, 1.5]) {
        await assert.rejects(
          h.tools.get('agnes_video').execute({ prompt: 'x', frames, waitSeconds: 0 }, exec()),
          /8n\+1/,
        )
      }
      assert.equal(h.calls.length, 0)
    } finally {
      h.restore()
    }
  })

  test('text-to-video omits both image fields', async () => {
    const h = mount({ handler: queued })
    try {
      const value = await h.tools.get('agnes_video').execute({ prompt: 'x', waitSeconds: 0 }, exec())
      assert.equal(h.calls[0].body.image, undefined)
      assert.equal(h.calls[0].body.extra_body, undefined)
      assert.equal(value.ok, false)
      assert.equal(value.videoId, 'video_1')
    } finally {
      h.restore()
    }
  })

  test('one image rides the image field; several images ride extra_body', async () => {
    const single = mount({ files: { 'a.png': png(800, 800) }, handler: queued })
    try {
      await single.tools.get('agnes_video').execute({ prompt: 'x', images: ['a.png'], waitSeconds: 0 }, exec())
      assert.match(single.calls[0].body.image, /^data:image\/png;base64,/)
      assert.equal(single.calls[0].body.extra_body, undefined)
    } finally {
      single.restore()
    }
    const many = mount({ files: { 'a.png': png(800, 800), 'b.png': png(800, 800) }, handler: queued })
    try {
      await many.tools.get('agnes_video').execute(
        { prompt: 'x', images: ['a.png', 'b.png'], mode: 'keyframes', waitSeconds: 0 },
        exec(),
      )
      assert.equal(many.calls[0].body.extra_body.image.length, 2)
      assert.equal(many.calls[0].body.extra_body.mode, 'keyframes')
      assert.equal(many.calls[0].body.image, undefined)
    } finally {
      many.restore()
    }
  })

  test('a completed task downloads its video and reports the path', async () => {
    const h = mount({
      config: { pollIntervalMs: 1 },
      handler: (url) => {
        if (url.endsWith('/videos')) return json({ video_id: 'video_9', status: 'queued' })
        if (url.includes('/agnesapi')) {
          return json({ video_id: 'video_9', status: 'completed', progress: 100, metadata: { url: 'https://cdn.test/v.mp4' } })
        }
        return binary(Buffer.from('MP4BYTES'))
      },
    })
    try {
      const value = await h.tools.get('agnes_video').execute({ prompt: 'x', waitSeconds: 5, name: 'v.mp4' }, exec())
      assert.equal(value.ok, true)
      assert.equal(value.status, 'completed')
      assert.equal(readFileSync(value.path).toString(), 'MP4BYTES')
    } finally {
      h.restore()
    }
  })

  test('a failed task surfaces the provider error', async () => {
    const h = mount({
      config: { pollIntervalMs: 1 },
      handler: (url) => url.endsWith('/videos')
        ? json({ video_id: 'video_2', status: 'queued' })
        : json({ video_id: 'video_2', status: 'failed', error: { message: 'moderation rejected' } }),
    })
    try {
      const value = await h.tools.get('agnes_video').execute({ prompt: 'x', waitSeconds: 5 }, exec())
      assert.equal(value.ok, false)
      assert.equal(value.status, 'failed')
      assert.match(String(value.error), /moderation rejected/)
    } finally {
      h.restore()
    }
  })

  test('agnes_video_status resumes an existing id without creating a task', async () => {
    const h = mount({
      config: { pollIntervalMs: 1 },
      handler: (url) => url.includes('/agnesapi')
        ? json({ video_id: 'video_3', status: 'completed', progress: 100, url: 'https://cdn.test/v3.mp4' })
        : binary(Buffer.from('RESUMED')),
    })
    try {
      const value = await h.tools.get('agnes_video_status').execute({ videoId: 'video_3', name: 'v.mp4' }, exec())
      assert.equal(value.ok, true)
      assert.equal(readFileSync(value.path).toString(), 'RESUMED')
      assert.equal(h.calls.filter(call => call.url.endsWith('/videos')).length, 0)
    } finally {
      h.restore()
    }
  })
})

// ── retry policy ────────────────────────────────────────────────────────────

describe('retry policy', () => {
  test('a non-idempotent create is never repeated after a transport failure', async () => {
    const h = mount({
      handler: () => { throw new Error('socket hang up') },
    })
    try {
      await assert.rejects(
        h.tools.get('agnes_video').execute({ prompt: 'x', waitSeconds: 0 }, exec()),
        /not idempotent/,
      )
      assert.equal(h.calls.length, 1, 'the create must be attempted exactly once')
    } finally {
      h.restore()
    }
  })

  test('a transport failure on an idempotent call is retried', async () => {
    const h = mount({ config: { retryStepMs: 1 }, handler: () => { throw new Error('socket hang up') } })
    try {
      await assert.rejects(h.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec()))
      assert.equal(h.calls.length, 5, 'the image call should have used every attempt')
    } finally {
      h.restore()
    }
  })

  test('the retry sequence stops at the operation deadline', async () => {
    const h = mount({ config: { operationDeadlineMs: 1 }, handler: () => { throw new Error('socket hang up') } })
    try {
      await assert.rejects(
        h.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec()),
        /retry budget of 1ms exhausted/,
      )
      assert.equal(h.calls.length, 1)
    } finally {
      h.restore()
    }
  })

  test('a retryable status is retried, a client error is not', async () => {
    const retryable = mount({
      config: { operationDeadlineMs: 1 },
      handler: () => json({ error: { message: 'busy' } }, 503),
    })
    try {
      await assert.rejects(retryable.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec()), /busy/)
      assert.equal(retryable.calls.length, 1)
    } finally {
      retryable.restore()
    }
    const clientError = mount({ handler: () => json({ error: { message: 'bad prompt' } }, 400) })
    try {
      await assert.rejects(clientError.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec()), /bad prompt/)
      assert.equal(clientError.calls.length, 1)
    } finally {
      clientError.restore()
    }
  })
})

// ── rendering ───────────────────────────────────────────────────────────────

describe('render', () => {
  test('the image result names the file, and adds the picture when one was attached', async () => {
    const attachment = { saveImage: async () => ({ attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 7, width: 8, height: 8, name: 'a.png' }) }
    const h = mount({ handler: imageOk, attachments: attachment })
    try {
      const tool = h.tools.get('agnes_image')
      const value = await tool.execute({ prompt: 'PROMPT-MARKER', name: 'a.png' }, exec())
      const blocks = tool.output.render({ prompt: 'PROMPT-MARKER' }, value)
      assert.deepEqual(blocks.map(block => block.type), ['text', 'image'])
      assert.match(blocks[0].text, /a\.png/)
      assert.doesNotMatch(blocks[0].text, /PROMPT-MARKER/, 'render must read the result, not the arguments')
      assert.doesNotMatch(blocks[0].text, /undefined/)
    } finally {
      h.restore()
    }
  })

  test('a refused attachment still yields a successful call with text only', async () => {
    const attachment = { saveImage: async () => { throw new Error('IMAGE_DIMENSION_TOO_LARGE') } }
    const h = mount({ handler: imageOk, attachments: attachment })
    try {
      const tool = h.tools.get('agnes_image')
      const value = await tool.execute({ prompt: 'x', name: 'a.png' }, exec())
      assert.equal(value.inline, undefined)
      assert.deepEqual(tool.output.render({}, value).map(block => block.type), ['text'])
    } finally {
      h.restore()
    }
  })

  test('a settled video names its file; a pending one hands back the id', () => {
    const h = mount({ handler: imageOk })
    try {
      const tool = h.tools.get('agnes_video')
      const settled = tool.output.render({}, { ok: true, videoId: 'video_1', status: 'completed', progress: 100, path: '/w/v.mp4', bytes: 9, error: null })
      assert.match(settled[0].text, /\/w\/v\.mp4/)
      const pending = tool.output.render({}, { ok: false, videoId: 'video_1', status: 'in_progress', progress: 30, path: null, bytes: null, error: null })
      assert.match(pending[0].text, /video_1/)
      assert.match(pending[0].text, /agnes_video_status/)
      assert.doesNotMatch(pending[0].text, /undefined/)
    } finally {
      h.restore()
    }
  })

  test('every rendered result states the model and the endpoint it called', async () => {
    const h = mount({ handler: imageOk })
    try {
      const image = await h.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec())
      assert.equal(image.model, 'agnes-image-2.5-flash')
      assert.equal(image.apiBase, 'https://apihub.agnes-ai.com/v1')
      assert.equal(image.endpoint, 'https://apihub.agnes-ai.com/v1/images/generations')
      assert.match(h.tools.get('agnes_image').output.render({}, image)[0].text, /model agnes-image-2\.5-flash at https:\/\/apihub\.agnes-ai\.com\/v1, POST https:\/\/apihub\.agnes-ai\.com\/v1\/images\/generations/)

      const video = h.tools.get('agnes_video')
      const settled = video.output.render({}, {
        ok: true, model: 'agnes-video-v2.0', apiBase: 'https://api.test/v1', endpoint: 'https://api.test/v1/videos',
        videoId: 'video_1', status: 'completed', progress: 100, path: '/w/v.mp4', bytes: 9, error: null,
      })
      assert.match(settled[0].text, /model agnes-video-v2\.0 at https:\/\/api\.test\/v1, POST https:\/\/api\.test\/v1\/videos/)
      const pending = video.output.render({}, {
        ok: false, model: 'agnes-video-v2.0', apiBase: 'https://api.test/v1', endpoint: 'https://api.test/v1/videos',
        videoId: 'video_1', status: 'in_progress', progress: 30, path: null, bytes: null, error: null,
      })
      assert.match(pending[0].text, /model agnes-video-v2\.0/)
    } finally {
      h.restore()
    }
  })

  test('a result without provenance renders no undefined line', async () => {
    const h = mount({ handler: imageOk })
    try {
      const image = await h.tools.get('agnes_image').execute({ prompt: 'x', name: 'a.png' }, exec())
      const legacy = { ...image }
      delete legacy.model
      delete legacy.apiBase
      delete legacy.endpoint
      assert.doesNotMatch(h.tools.get('agnes_image').output.render({}, legacy)[0].text, /undefined/)
      const video = h.tools.get('agnes_video')
      assert.doesNotMatch(
        video.output.render({}, { ok: true, videoId: 'video_1', status: 'completed', progress: 100, path: '/w/v.mp4', bytes: 9, error: null })[0].text,
        /undefined/,
      )
    } finally {
      h.restore()
    }
  })
})
