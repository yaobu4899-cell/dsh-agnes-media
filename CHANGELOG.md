# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
