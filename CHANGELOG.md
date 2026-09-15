# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-15

### Added

- The video tools speak both Agnes video contracts. `agnes_video` detects the
  2.5 family from the configured model id and builds that family's request —
  `mode`, `seconds` as a string, `size: "720P"`, and an `aspect_ratio` — instead
  of the v2.0 one. New optional arguments: `seconds`, `aspectRatio`, and `seed`.
  Polling adds `model_name=<model>` for the 2.5 family, which its documentation
  requires for every mode but `text` and accepts for `text` too.

### Fixed

- `agnes_video` no longer sends v2.0 fields to a 2.5 model. Measured against the
  live service, `agnes-video-2.5-flash` answers `HTTP 400: width is a forbidden
  field`, then the same for `height` and `num_frames`, so pinning the plan's
  listed video model made every render fail. Both contracts are now verified end
  to end against the live service: 2.5-flash text-to-video completed in 120 s for
  a 493,535-byte MP4, and v2.0 image-to-video from a local file completed in
  103 s for a 559,820-byte MP4.

### Changed

- The 2.5 family refuses a local input file by name and before any request,
  because that family answers 400 for the Data URI a Session file becomes. The
  refusal names the model, the limitation, and `agnes-video-v2.0` as the family
  that accepts local files.
- A duration stated as `seconds` now converts to the `8n+1` frame count the v2.0
  family expects, so one argument states duration on either family.

## [0.4.2] - 2026-09-15

### Changed

- `waitSeconds` defaults to 540 in both video tools, up from 240 in `agnes_video`
  and 120 in `agnes_video_status`. One creation call now usually outlasts the
  render, which keeps the common case inside the call that started the task. A
  task still rendering at the deadline has to be collected later, and a provider
  record does not stay resolvable: the vendor documentation states no retention
  window, and in measurement two of five tasks created in one session had stopped
  answering while three others still did. A task whose record is gone answers
  `HTTP 404 task not found` and has to be rendered again, so a second round trip
  is the expensive outcome this default avoids. Callers wanting a quick look pass
  a smaller `waitSeconds`; the schema states the new default.

### Fixed

- The `v0.4.1` note below claimed a LiteLLM routing key cannot be used to poll.
  Measurement does not support that: for a record the provider still holds, the
  routing key and the bare `video_id` both answer `HTTP 200` with the same `url`.
  The unwrapping stands, because the bare id is the form the provider issued and
  the vendor documents, but it is not what causes a 404. A 404 means the provider
  no longer holds that task record; both id forms answer it together.

## [0.4.1] - 2026-09-15

### Fixed

- A video task is polled with the id the provider resolves. A deployment fronted
  by a LiteLLM proxy answers task creation with a routing key — `video_` plus
  the base64 of `litellm:custom_llm_provider:<p>;model_id:<m>;video_id:<bare>` —
  and asking `GET /agnesapi?video_id=<routing key>` answers
  `HTTP 404 task not found`, because the provider issued only the bare id inside
  it. Measured against the live service: the same task that answers 404 for the
  routing key answers 200 with its `url` for the bare `video_id`. Every poll now
  unwraps the key, while the result keeps returning the key the provider sent, so
  a caller can pass it straight back to `agnes_video_status`. An id that carries
  no decodable `video_id` reaches the provider unchanged rather than being
  rewritten into a guess.

### Changed

- The video tools state that a settled task must be collected promptly. A
  completed record carries its MP4 at the top-level `url`, and the provider's
  documented fields include `expires_at`; the vendor documentation states no
  retention window, and in measurement two of five tasks created in one session
  had stopped resolving while three others still answered.

## [0.4.0] - 2026-09-15

### Added

- Every tool result and rendered line now states the model and the endpoint the
  call used: `model <id> at <base>, POST <endpoint>`. `agnes_image` already
  returned `model`; `agnes_video` and `agnes_video_status` did not, so the model
  a video task actually used was readable only from the session log. The
  `agnes_video_status` result reports the model this deployment would submit,
  because a status call resumes a task it did not create and carries no request
  body. The line is omitted when a result carries no provenance, so a record
  written by an earlier version never renders `undefined`.

### Fixed

- Eleven text literals carried double-encoded mojibake from an earlier edit: ten
  held the two characters a UTF-8 em dash becomes when its bytes are read as
  GBK, and two held the same damage around an arrow (with one of those two
  overlapping). Two of them sat inside model-facing strings, so the tool catalog
  shipped a description reading `and <mojibake> when the image fits` and every
  rendered image and video line opened with `<mojibake>`. The intended em dashes
  and arrows are restored, with their spacing, and no non-ASCII character other
  than the em dash and the ellipsis remains in `index.js`.

## [0.3.1] - 2026-09-15

### Fixed

- The output-name check refuses `\` on every platform. On POSIX it was an
  ordinary name character, so `sub\dir.png` and `C:\abs.png` were accepted and
  written as a single file whose name contains a path separator — a file that
  becomes a directory entry once the workspace reaches a Windows host or share.
  Windows already refused both through `basename()`; the check no longer depends
  on the platform's separator semantics.
- The test suite passes on Linux as well as Windows. The output-name test
  asserted Windows separator semantics everywhere, which the CI matrix caught on
  the first run.

## [0.3.0] - 2026-09-15

### Added

- A test suite (`node --test`, no dependencies) covering configuration
  validation, output-name hygiene, every image and video request body, the
  aspect inference, the retry policy, and each render output.
- `requestTimeoutMs`, `operationDeadlineMs`, and `retryStepMs` configuration
  fields, so one call's HTTP budget is a deployment choice rather than a
  constant.
- Each tool declares a `timeoutMs`, letting the harness's tool-call timeout
  policy bound a call as well.

### Changed

- With `images`, an omitted `ratio` is now inferred from the first input whose
  own header states its size (PNG, JPEG, GIF, WebP), so a redraw keeps the
  input's framing instead of being re-composed at the `3:4` default. An explicit
  `ratio` still wins, and a URL or Data URI input keeps the default because
  nothing here may download it.

### Fixed

- Creating a video task is no longer retried after a transport failure. The
  request is not idempotent: a connection that dies after the provider accepted
  it would otherwise queue and bill a second render. That failure now names
  itself and says so.
- A failed video task reports the provider's own message. Its `error` field
  arrives as a `{ message, type, code }` object, which previously stringified
  into `[object Object]`.

## [0.2.0] - 2026-09-14

### Added

- `images` on both generating tools: one entry is image-to-image, several
  compose them together; on `agnes_video` one entry is image-to-video and
  several drive a keyframe transition with `mode: "keyframes"`.
- Input images are read through the deployment's sandboxed `fs` service and
  inlined as Data URIs, which the provider documents as the alternative when an
  image cannot be made public. Public URLs and existing Data URIs pass through
  untouched.
- `maxInputImageBytes` configuration field.

### Fixed

- An empty `revised_prompt` is reported as `null` rather than an empty string.

## [0.1.0] - 2026-09-14

### Added

- Initial release: `agnes_image`, `agnes_video`, and `agnes_video_status` as
  model-facing tools that write generated media into the Session workspace.
- Inline image results through the attachment service, best effort under its
  admission limits.
- Backoff retries for the provider's rate limits and server errors, a
  per-request credential resolution, and output-name validation that keeps a
  model-chosen name inside the Session workspace.
