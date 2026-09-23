# Contributing

Thanks for considering a contribution. This document covers the working
agreements that keep the library trustworthy — most of them exist because a
test or a release once failed without them.

## Ground rules

- **The offline test suite stays offline.** `pnpm test` must never touch the
  network or require an API key. Real-SDK round trips live in the opt-in
  `pnpm test:live` suite, gated on `RUBRIC_LIVE=1` plus a provider key; CI
  never sets either.
- **No new runtime dependencies.** Everything except `partial-json` is an
  optional peer, so users who don't call a feature never install its weight.
  If a change seems to need a dependency, raise it in an issue first.
- **Guarantees are tested, not stated.** If a PR claims a behavior
  (truncation detection, conflict listing, partial results on interruption),
  the offline suite must pin it with a test before it ships.

## Getting started

Requires Node 20+ and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/tomnio/rubric && cd rubric
pnpm install
pnpm typecheck   # types only, includes examples/
pnpm test        # offline suite (~410 tests, no credentials)
pnpm build       # emits dist/ — required before the entry-point tests
```

CI runs `build` **before** `test`: the package-entry contract tests require
`dist/` to exist. If those tests fail locally with `Cannot find module
dist/index.js`, run `pnpm build` — a stale or missing local dist is the usual
cause of "green locally, red in CI".

## Tests

- **Where:** `tests/*.test.ts`, one file per concern, run with
  [vitest](https://vitest.dev). Fakes are hand-built client objects — see any
  existing `tests/*.test.ts` for the shape; no mocking framework.
- **What to add:** every behavior change ships with tests. Bug fixes ideally
  add the failing test first. Type-level guarantees (the `wrap(new OpenAI())`
  assignability, `cited()`'s inferred output) are pinned in
  `tests/type-contracts.test.ts` — compile errors are the assertions.
- **Live tests:** `tests/live/` only. A live suite must skip cleanly when its
  key is absent, so `pnpm test` and CI stay green without credentials.
- **Fixtures:** build them in-process (see `tests/pdf.test.ts` generating PDFs
  with pdf-lib). No binary fixtures in the repo.

## Commit and PR conventions

- **One concern per PR.** A feature, a fix, or a docs change — not a mix.
  Size is not a problem; scope mixing is.
- **Commit style:** imperative subject line, body explains *why*. Look at
  `git log` for the register.
- **PR description:** what changed, why, and a test plan (what you ran, what
  CI will run).
- **Squash merges by default.** The PR, not the branch, is the unit of
  history.
- **English everywhere in the repo** — code, comments, commit messages, PR
  descriptions, docs.

## Design invariants

These repeatedly come up in review. If a change breaks one of them, it needs
a very good argument in the PR:

- **`create()` returns `z.infer<S>` or throws a typed error** — never an
  unvalidated guess. New code paths must preserve this.
- **The SDK is wrapped, never patched.** `wrap()` inspects the client shape
  and returns an adapter; the caller's client object is left untouched.
- **Merging is deterministic and makes no model call.** There is deliberately
  no LLM "reduce" pass — a second unvalidated call would reopen the failure
  modes the library exists to close.
- **Entry points are separately importable.** `create()` must not pull in the
  WASM chunker or the PDF parser; `@chonkiejs/core` and `unpdf` are optional
  peers loaded by dynamic import behind their own subpaths.
- **Failure states carry their evidence.** Interruptions return the partial
  result and usage; conflicts name both values and their windows; truncation
  reports the provider's marker. A new error type should follow this shape.

## Releases

Maintainers: see [RELEASE.md](RELEASE.md) — bump version in a PR, merge, sign
the tag, and the Release workflow publishes. Keep the git tag,
`package.json`, and npm on the same number, and update `CHANGELOG.md` in the
same release PR.

## Reporting a bug

Open an issue with: the rubric version, the provider and mode, the smallest
schema + input that reproduces it, and what you expected instead. Error
objects are designed to be dumped — their fields are the diagnosis.
