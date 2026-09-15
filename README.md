# dsh-agnes-media

Agnes AI image and video generation as DeepSeek Harness tools.

The plugin registers three model-facing tools that call the Agnes AI HTTP API
and write the generated media into the calling Session's workspace.

| Tool | What it does |
| --- | --- |
| `agnes_image` | Text-to-image, image-to-image, and multi-image composition. Saves a PNG, and additionally publishes it as a durable image attachment so the result renders inline. |
| `agnes_video` | Text-to-video, image-to-video, and keyframe animation. Creates the asynchronous task and waits for it, returning the `video_id` when the render outlives the call. |
| `agnes_video_status` | Resumes a `video_id` and downloads the finished MP4. |

## Prerequisites

- A DeepSeek Harness deployment with a Web profile (`$DSH_HOME/profiles/web`).
- An Agnes AI account and API key, from the [Agnes AI platform](https://platform.agnes-ai.com/).
  The tools read it through the credential reference named by `apiKeyEnv`
  (default `AGNES_API_KEY`), resolved per request — so storing the key on the
  Models settings page is enough, and replacing it takes effect on the next call
  without a restart.

Image and video generation are billed by the provider per image and per second
of video; at the time of writing both are free of charge. Text models are the
token-billed ones, and this plugin never calls one.

## Input images

Both generating tools accept `images`, a list of inputs that turns the call from
text-driven into image-driven. Each entry is one of:

- a **public URL** (`https://…`) — passed to the provider unchanged;
- a **Data URI** (`data:image/png;base64,…`) — passed unchanged;
- a **Session path** — absolute, or relative to the Session workspace — which the
  plugin reads through the deployment's sandboxed `fs` service and inlines as a
  Data URI. The provider documents that form as the alternative when an image
  cannot be made public, and it works for video input as well as image input.

| Call | `images` | Effect |
| --- | --- | --- |
| `agnes_image` | one entry | image-to-image: redraw that picture |
| `agnes_image` | several entries | multi-image composition |
| `agnes_video` | one entry, no `mode` | image-to-video: animates that picture |
| `agnes_video` | several entries, or any `mode` | sent as `extra_body.image`, e.g. a keyframe transition with `mode: "keyframes"` |

Reads go through `ctx.fs`, so the deployment's file policy still applies; the
byte ceiling is `maxInputImageBytes` (8 MiB by default, before base64 expansion).

## Install

The plugin belongs to the **agent plane**: the deployment's Web profile disables
every host-plane tool row so each agent preset decides its own tool catalog, so
this package is installed into the profile and named by a preset row.

1. Add the package to the profile and install it:

   ```sh
   cd "$DSH_HOME/profiles/web"
   pnpm add github:yaobu4899-cell/dsh-agnes-media
   ```

   Pin a revision for a reproducible install, and use a local checkout instead
   while developing the plugin:

   ```sh
   pnpm add 'github:yaobu4899-cell/dsh-agnes-media#<commit-sha>'
   pnpm add file:/path/to/dsh-agnes-media
   ```

   `file:` copies the directory rather than linking it, so after editing the
   plugin, remove `node_modules/dsh-agnes-media` and add it again — pnpm may
   otherwise report "Already up to date" while the installed copy is stale. The
   running process also keeps the module it already imported, so a plugin change
   takes effect at the next Host restart.

2. Add the row to a preset you own (see `editing-cordis-compositions`; never
   edit a shipped preset):

   ```yaml
   - id: tool-agnes-media
     name: dsh-agnes-media
   ```

3. Mount-validate the preset, then start a Session on it.

## Configuration

Every field is optional. A supplied field of the wrong type fails at load rather
than at the first model call.

| Field | Default | Meaning |
| --- | --- | --- |
| `baseURL` | `https://apihub.agnes-ai.com/v1` | API root. Generation endpoints are `/images/generations` and `/videos` under it. |
| `videoStatusURL` | `https://apihub.agnes-ai.com/agnesapi` | Task-status endpoint, queried as `?video_id=<id>`. It is not under `baseURL`. |
| `apiKeyEnv` | `AGNES_API_KEY` | Credential reference resolved per request, so a key stored in Models settings reaches the next call without a restart. |
| `imageModel` | `agnes-image-2.5-flash` | Image model id. |
| `videoModel` | `agnes-video-v2.0` | Video model id. |
| `pollIntervalMs` | `5000` | Video polling interval. |
| `maxMediaBytes` | `134217728` | Inclusive cap on one downloaded result. |
| `maxInputImageBytes` | `8388608` | Inclusive cap on one input image read from a Session path, before base64 expansion. |
| `requestTimeoutMs` | `300000` | Ceiling on one HTTP attempt. |
| `operationDeadlineMs` | `360000` | Ceiling on the whole retry sequence, so a slow provider cannot stretch one call without bound. |
| `retryStepMs` | `4000` | First backoff step; each further attempt waits one step longer. |

## Behaviour worth knowing

- **Retries.** 429 and 5xx are retried up to five attempts with linear backoff,
  inside `operationDeadlineMs`. Transport failures are retried only for
  idempotent calls: creating a video task is attempted **once**, because a
  connection that dies after the provider accepted the request would otherwise
  queue and bill a second render. That failure names itself instead.
- **Timeouts.** Each tool declares a `timeoutMs`, so the harness's tool-call
  timeout policy can also bound it; the plugin's own budget is the tighter one.
- **Redraws keep the input framing.** With `images`, an omitted `ratio` is taken
  from the first input whose own header states its size (PNG, JPEG, GIF, WebP).
  A public URL or Data URI input cannot be measured without downloading it, so
  such a call keeps the `3:4` default. An explicit `ratio` always wins.
- **Output location.** Media is written into the Session workspace, named by the
  model. The name is a bare file name: a directory, an absolute path, or a `..`
  segment is refused, so the model chooses the file name but never the directory.
- **Inline images are best effort.** Attachment admission limits (side length,
  byte cap) may refuse a large image; the file on disk is the deliverable and the
  call still succeeds. A refused attachment is logged.
- **Video states.** Polling stops on `completed`/`succeeded`/`success` and on
  `failed`/`error`/`cancelled`/`canceled`; anything else keeps polling until the
  call's wait budget runs out, at which point the `video_id` comes back for
  `agnes_video_status`. A failed task reports the provider's own message rather
  than stringifying its error object.
- **Frame counts.** `frames` must be `8n+1` and at most 441, which the tool
  validates before creating a task.

## Tests

```sh
cd /path/to/dsh-agnes-media
node --test
```

The suite stubs `fetch` and the plugin context, so it needs no API key and no
network. It covers configuration validation, output-name hygiene, every image and
video request body, the aspect inference, the retry policy including the
non-idempotent create, and each render output.

## Why the package has no dependencies

Tool definitions are raw JSON Schema handed to `ctx.tools.register`, and the
plugin touches the harness only through the `tools`, `credentials`, and `fs`
services it injects. Nothing is imported from `@deepseek-ai/*`, so the package
installs from a local path with no build step and no peer resolution to get
wrong. The trade-off is that configuration is validated by hand instead of by a
schemastery `Config` export; an invalid row still fails loudly at load.
