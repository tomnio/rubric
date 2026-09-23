# Security Policy

## Supported versions

The latest published release on npm is the supported version. The project is
pre-1.0: security fixes land in a patch release, and backports to older minor
lines are not made.

## Reporting a vulnerability

Open a private security advisory: GitHub → Security → "Report a vulnerability"
on this repository. Please do not open a public issue for anything you believe
is exploitable.

Include: the version, the provider and mode involved, and a minimal
reproduction. You will get an acknowledgment within a few days.

## Scope notes specific to this library

- Rubric sends the caller's document text and schema to whatever LLM provider
  the caller configured. It makes no network calls of its own beyond that.
  Data-handling questions ("does my prompt reach the vendor") are provider
  questions, answered by the SDK the caller wrapped.
- The offline test suite (`pnpm test`) never touches the network. The opt-in
  live suite (`pnpm test:live`) reads credentials from a gitignored `.env` and
  only sends them to the provider endpoints they name.
- Prompt-injection resistance is a design concern, not an afterthought:
  `MD_JSON` takes the *last* JSON span so a quoted document cannot hijack the
  parsed result, and `cited()` verifies quotes against the source so a
  fabricated citation fails validation. These are pinned by tests; a
  regression in either is a security-relevant bug.
