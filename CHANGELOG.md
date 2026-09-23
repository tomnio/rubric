# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Dates are UTC, from the signed release tags.

## [Unreleased]

## [0.11.0] — 2026-09-21

### Added

- **`joinPages()`** (`@tomnio/rubric/pdf`): joins per-page text from
  `extractPdfPages()` into one document string while recording each page's span
  in it. The spans share the coordinate space of the chunk offsets
  `createDocument()` reports, so a merged value can be traced back to the page
  it came from. The separator sits between pages and belongs to neither span,
  so an offset inside a span is unambiguously inside a page.

### Housekeeping

- CI: `actions/checkout` and `actions/setup-node` bumped to v5.
- README: test-count line updated (410 tests, 42 files).

## [0.10.0] — 2026-09-19

### Added

- **`@tomnio/rubric/pdf` — new public entry point.** `extractPdfPages()`
  turns a PDF into per-page text (`{ totalPages, pages: [{ number, text }] }`)
  ready for `createDocument()`. The product chain is now end to end:
  PDF → text → chunked extraction → merged, validated JSON.
  - Text layer only, no OCR — a scanned page has no text layer and yields an
    empty string.
  - `unpdf` as an optional peer, pinned `>=1.7.0 <1.8` — 1.8+ declares
    `node >= 22`, and this package supports Node 20. Loaded via dynamic import
    with an install hint when absent.
  - Safe buffer reuse — the input is copied before reaching the parser, because
    pdf.js takes ownership of the buffer it is handed; the same file buffer
    works across repeated calls (pinned by test).

### Changed

- npm `keywords` ship for the first time (search discoverability).

### Docs

- README restructured (~700 → ~516 lines): the full `createDocument()`
  reference moved to [docs/document.md](docs/document.md),
  Features/Guarantees tables deduplicated, Quick start is installation only.

## [0.9.1] — 2026-09-16

### Fixed

- **CJS `require()` works again** — `require("@tomnio/rubric")` and
  `require("@tomnio/rubric/document")` load the ESM dist through Node's
  require-of-ESM (0.9.0 failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`).
  No CJS build added; pinned by contract tests.

### Docs

- Evaluator evidence pack: README leads with motivation, a guarantees table,
  and the headline measurement; `docs/benchmarks.md` documents the correctness
  study end to end, including threats to validity.

### Infrastructure

- CI runs `pnpm build` before the test suite (the entry-point contract test
  requires dist), and `prepublishOnly` is ordered the same way; a missing dist
  now fails with an actionable message.

## [0.9.0] — 2026-09-16

### Added

- **Partial results on interruption**: when a timeout, caller abort, or
  document token budget cuts `createDocument()` short,
  `DocumentInterruptedError` now carries `partial` (completed chunks merged
  best-effort), per-chunk `chunks` provenance, and `usage` — the tokens you
  paid for are no longer dropped.
- **`fromProvider()` vendor router**: `fromProvider("deepseek/deepseek-chat")`
  builds the right client from one string. Official OpenAI / Anthropic / Google
  SDKs are loaded dynamically (install only the one you use); five
  OpenAI-compatible vendors route with their base URLs and default modes.
- **Long-document example with extraction scoring**:
  `pnpm example:extract-long-document` generates a deterministic ~55-page
  report with planted entities and scores naive `create()` vs
  `createDocument()` on recall, duplicate rate, tokens, and wall time.

## [0.8.1] — 2026-09-16

### Added

- **Zod 4 support**: works with **both Zod 3 (>= 3.24) and Zod 4**. The peer
  range is `^3.24.0 || ^4.0.0`, so a bare `pnpm add zod` resolves cleanly.
  CI runs the full test suite against both majors.

### Fixed

- Scrubbed published comments: the tarball's `.d.ts` / `.js` comments no
  longer contain cross-project mentions.

## [0.8.0] — 2026-09-16

### Added

- **`onConflict: "error"`** — `createDocument()` and `mergeChunks()` can now
  fail on a field two chunks reported differently, instead of silently keeping
  the first. The thrown `DocumentConflictError` lists every disagreeing field
  with the value and window each chunk read it from. Equality is structural;
  `null` counts as absence; array fields are exempt (they concatenate).
- **`dedupeBy`** — name the field that identifies an array item so an entity
  the model **reworded** across a boundary is recognised as one item and its
  two readings are merged, unioning their fields.
- **`timeout`** — a wall-clock budget for the whole call, retries included. On
  `createDocument()` it spans the document, not one chunk.
- **`OutputTruncatedError`** — a response cut off by the provider's token
  limit is reported as truncated rather than reasked, since the model cannot
  fix a cap by rewording. Carries `reason`, the `raw` response, and `attempts`.
- **`pnpm test:live`** — an opt-in suite that makes real SDK round trips,
  gated on `RUBRIC_LIVE=1` plus a provider key. `pnpm test` and CI stay
  offline and green with no credentials.

### Fixed

- **`wrap(new OpenAI())` now typechecks.** The duck-typed client types
  declared `create` as a function-typed property, whose parameters are checked
  contravariantly. Method syntax makes the check bivariant. This is the first
  line of the README, and it had never been caught because `examples/` was not
  typechecked — it is now.
- **`cited()`'s output is typed.** `z.infer` on a `cited()` schema resolved to
  `unknown`, so callers had to cast the result of `create()` to read
  `substring_quotes`.

### Changed

- **`tokenBudget` on `createDocument()` now measures the whole document**,
  not each chunk. The per-chunk guardrail moved to a new `chunkTokenBudget`.
  **Breaking** for `createDocument()` callers who relied on the old per-chunk
  meaning.

## [0.7.0] — 2026-09-15

### Added

- **`@tomnio/rubric/document` is now a published entry point.**
  `createDocument()` splits a long text, runs the same extraction on each
  chunk, and merges the results into one validated object, with per-chunk
  provenance (`index`, `startIndex`, `endIndex`, `value`, `usage`). It needs
  one extra optional peer, `@chonkiejs/core`.
- **`dedupe`** — how to treat a value more than one chunk reported.
  `"overlap"` (default) counts it once when the two chunks' windows overlap;
  `"none"` keeps every repeat.
- **`DocumentNoDataError`** — thrown when no chunk produced a value, carrying
  `reason`, `chunkErrors`, and the `usage` already spent.
- **`chunk` on `AttemptMeta`** — during `createDocument()`, every hook can
  tell which chunk fired it.

### Fixed

- `overlap` is applied in the pipeline rather than inside each chunker, so
  boundary recovery works for custom chunkers too. **Breaking change** to the
  `Chunker` type: a chunker now receives `{ chunkSize }` only.
- `maxRetries` is validated before the first request.
- `RetryExhaustedError.lastError` is `undefined` when no attempt ever ran.

## [0.6.0] — 2026-09-15

### Added

- **Citation anti-hallucination** — `cited(schema)` extends an object schema
  with a `substring_quotes` field and checks every quote against the source
  text passed as `create({ context })`. A quote that is not an exact substring
  triggers a reask instead of being silently dropped.
- **LLM-as-judge validation** — `llmRefine(rule, client)` is an async Zod
  refinement that asks a model whether a value satisfies a natural-language
  rule. A failing verdict becomes a validation issue and flows back through
  the normal reask loop.
- **Completeness-aware streaming** — `createPartial()` validates a subtree
  only once it has fully arrived. Closed-but-invalid subtrees are dropped;
  open subtrees keep whatever has streamed in.

### Changed

- **`MD_JSON` extraction takes the last JSON span, not the first.** The
  model's answer (which comes last) now wins over any JSON quoted earlier in
  the text. This closes a prompt-injection path where a quoted document could
  hijack the parsed result.

### Internal

- Validation state is carried per call via `AsyncLocalStorage`, so concurrent
  `create()` calls cannot observe each other's citation source or model.

## [0.5.0] — 2026-09-15

### Added

- **Gemini** — `GEMINI_JSON` mode and `wrap(new GoogleGenAI({ apiKey }))`.
- **Gemini streaming** — `createPartial()` / `createIterable()` fixed for
  Gemini (the adapter had passed the SDK's promise straight to `yield*`, so
  every streaming call failed with `not async iterable`).
- **OpenAI-compatible gateways** — `compatible.*` presets (DeepSeek, Groq,
  OpenRouter, Together, Moonshot) with baseURL and default mode.

## [0.4.0] — 2026-09-14

### Changed

- Package identity: **`@tomnio/rubric`** on npm (unscoped `rubric` is taken).
  Git tag, `package.json`, and npm version all match from this release on.

## [0.3.0] — 2026-09-14

### Added

- **Token usage** — `hooks.onUsage` sums tokens across reasks;
  `RetryExhaustedError.usage` carries the same totals.
- **AbortSignal** — `create()` / `createPartial()` / `createIterable()` accept
  `signal`; an already-aborted signal throws before the LLM call.
- **Sampling** — `temperature`, `max_tokens`, `top_p` on `create()` and as
  `wrap()` defaults.
- **Anthropic images** — `imageUrl()` is mapped to `{ type: "image", source }`.

### Fixed

- **JSON_SCHEMA strict** — `.optional()`, `z.record`, and non-nullable unions
  fail locally in `prepareRequest` instead of at the live OpenAI API.

## [0.2.0] — 2026-09-13

### Added

- **`pnpm build`** emits `dist/` (JS + `.d.ts`); `package.json` `exports`
  point at `dist`.
- **Zod extras** — `z.union` / `z.discriminatedUnion`, `z.record`,
  `z.date()` (ISO strings coerced to `Date`).
- **Anthropic streaming** — `createPartial()` and `createIterable()` read
  `input_json_delta.partial_json`.

## [0.1.0] — 2026-09-11

### Added

- `wrap()` + `create()` (does not patch the SDK).
- Modes: `TOOLS`, `JSON_SCHEMA`, `MD_JSON`, `ANTHROPIC_TOOLS`.
- Reask on JSON / schema / `.refine()` failures (`maxRetries`, default 3).
- `maybe()`, hooks (`onRequest` / `onParseError` / `onSuccess`).
- `z.array(...)`; root arrays sent as `{ items: T[] }`.
- `createPartial()` (incomplete objects) and `createIterable()` (complete
  list items).
- `imageUrl()` for OpenAI image parts.
- OpenAI `chat.completions` and Anthropic `messages` duck-typing.
- Offline test suite and GitHub Actions CI (no live API keys).

[Unreleased]: https://github.com/tomnio/rubric/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/tomnio/rubric/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/tomnio/rubric/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/tomnio/rubric/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/tomnio/rubric/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/tomnio/rubric/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/tomnio/rubric/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/tomnio/rubric/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/tomnio/rubric/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/tomnio/rubric/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tomnio/rubric/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tomnio/rubric/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tomnio/rubric/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tomnio/rubric/releases/tag/v0.1.0
