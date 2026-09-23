# Architecture

This page explains how rubric is put together and, more importantly, **why**
it is put together that way — the decisions are the interesting part. The
[README](../README.md) covers what to call; this covers what happens when you
call it. Line references drift; the shape is stable.

```
                       ┌──────────────────────────────────────────┐
                       │                wrap(client)              │
                       │  toLLMClient(): duck-type → LLMClient    │
                       │  create / createPartial / createIterable │
                       └───────────────┬──────────────────────────┘
                                       │
              ┌────────────────────────┴───────────────────────┐
              │            extract() — the retry loop          │
              │  schema → mode handler → SDK call → JSON →     │
              │  Zod validate → reask with the error           │
              │  guardrails: tokenBudget · timeout · truncation│
              └────────────────────────┬───────────────────────┘
                                       │ one call per chunk
              ┌────────────────────────┴───────────────────────┐
              │        createDocument() — src/document/        │
              │  chunk → widen(overlap) → extract() × N →      │
              │  deterministic merge (no model call)           │
              └────────────────────────────────────────────────┘
```

Everything below the `wrap()` line is shared: a document chunk is an ordinary
`extract()` call with a `chunk` descriptor threaded into its hooks. The
pipeline adds no new model-facing behavior — reask, modes, budgets, and hooks
are inherited, not re-implemented.

## The core loop

`src/extract.ts` is ~240 lines and is the whole library in miniature:

```
prepare request ──► SDK call ──► parse JSON ──► Zod validate ──► return
       ▲                                              │
       └──────────── reask: attach the error ◄────────┘
```

Three properties of this loop are deliberate and load-bearing:

**Validation is the only source of truth.** The loop never inspects the raw
response on the success path. `parseResponse()` produces a candidate value,
`schema.safeParseAsync()` decides whether it is real, and a failure's Zod
issues become the reask text. This is why any Zod feature — `.refine()`,
`.superRefine()`, `cited()`, `llmRefine()` — composes without the loop knowing
it exists. It is also why `create()` can promise `z.infer<S>` or a typed
error: there is no path to the return value that skips validation.

**Errors that the model cannot fix stop the loop.** A reask says "here is what
was wrong, try again". That advice is useless for two failure classes:

- *Truncation* (`OutputTruncatedError`): the response stopped because the
  provider hit its output cap. Reasking resends the same `max_tokens` and gets
  cut in the same place. The loop checks the truncation marker (OpenAI
  `finish_reason === "length"`, Anthropic `stop_reason === "max_tokens"`,
  Gemini `finishReason === "MAX_TOKENS"`) **after** validation, so a response
  that validated despite the marker is still returned — the marker means "the
  model was stopped", not "the answer is unusable".
- *Provider / SDK errors*: a network failure is not a model mistake and is
  never retried. `maxRetries` counts reasks, not network retries.

**Guardrails check the failure path, not the success path.** `tokenBudget` is
consulted only when validation just failed — a valid answer that pushed the
total past the budget is returned, because the answer is in hand and the next
call is what the budget blocks. Same asymmetry as truncation: guard what has
not happened yet, never confiscate what already succeeded.

## Modes: one wire format per handler

A *mode* is a wire format — how the schema travels to the provider and how
JSON comes back. `src/modes/types.ts` defines the seam:

```ts
type ModeHandler = {
  prepareRequest(schema, kwargs)   // schema → request
  parseResponse(raw)               // response → candidate value
  handleReask(kwargs, raw, error)  // failure → next request
  deltaFromChunk(raw)              // streaming: chunk → text delta
}
```

Five handlers implement it (`TOOLS`, `JSON_SCHEMA`, `MD_JSON`,
`ANTHROPIC_TOOLS`, `GEMINI_JSON`), and `extract()` is mode-agnostic: it calls
the handler's three methods and knows nothing about `tool_calls` or markdown
fences. Adding a provider means adding one file, not touching the loop.

Two decisions inside the handlers are worth knowing:

- **`MD_JSON` takes the *last* JSON span, not the first.** A response that
  quotes a document's JSON before answering would otherwise let the quoted
  text hijack the parse — a prompt-injection path. The model's answer comes
  last, so last wins.
- **`JSON_SCHEMA` validates strict-safety locally.** OpenAI's strict subset
  rejects `.optional()` keys and open maps at the API, which would turn a
  schema mistake into a confusing remote 400. `prepareRequest` fails with a
  local error that names the field and the fix (`.nullable()`, or a different
  mode) before any request is sent.

`MD_JSON` deserves a note of its own: it exists because thinking models often
reject forced `tool_choice`, and OpenAI-compatible gateways vary in what they
support. A schema-in-a-fence prompt is the lowest common denominator that
works everywhere — including as the mode every gateway fallback converges on.

## The client seam: wrap, don't patch

`wrap(client)` duck-types what it receives (OpenAI `chat.completions`,
Anthropic `messages`, Gemini `.models`) into one internal `LLMClient` shape —
one method, `chatCompletionsCreate(kwargs, options)`. The adapter lives at the
boundary; everything above it is provider-blind.

The original client is never mutated. This is why the README can say "the
original client is unchanged" and why tests inject plain object fakes with no
mocking framework. It is also a type-system exercise: the duck-typed client
interfaces use method syntax so parameter checks are bivariant and the real
SDK's `create` — which takes a specific request type — remains assignable
(`tests/type-contracts.test.ts` pins this; it was once broken, and the README's
first example did not compile).

## The document pipeline

`src/document/` adds the "whole document" layer. Three decisions define it:

**Chunking is a seam, overlap is not.** A `Chunker` only splits and positions;
`createDocument()` widens whatever chunks come back by the overlap amount. A
custom chunker that ignores overlap still gets boundary recovery, and a
chunker that widened its own windows would be widened twice — so the option is
deliberately not passed to it.

**Merging is deterministic and makes no model call.** There is no LLM "reduce"
pass. A second unvalidated model call would be nondeterministic and would
reopen exactly the failure modes `create()` exists to close — the merged
result would be a guess again. Instead the merge is ~600 lines of rules:
array fields concatenate, scalars take the first non-null in chunk order,
`dedupe` collapses repeats only when their windows overlapped (an overlap
artifact), `dedupeBy` reunites an entity the model reworded across a boundary
by its key and unions the two readings' fields, and `onConflict: "error"`
turns a silent first-wins into a named list of disagreements. All of it is
testable against hand-built chunk values with no model in the room — which is
how the offline suite pins it.

**A chunk is an ordinary `extract()` call.** Not a special path — the same
loop, with a `chunk` descriptor threaded into every hook's `AttemptMeta`.
Budgets and the deadline widen to the document; `observe.onUsageAvailable`
tells the document-level budget whether every chunk reported token counts,
because a summed total over responses that omitted usage is not the real
spend, and enforcing a budget against it would be silently ineffective — so
it fails closed with `TokenUsageUnavailableError` instead.

The full option-level reference for this layer is
[docs/document.md](document.md); the measured no-loss study is
[docs/benchmarks.md](benchmarks.md).

## Error taxonomy

One principle: **a failure state carries its evidence**. If rubric stops
early, the error tells you what completed and what it cost.

| Error | When | What rides on it |
|---|---|---|
| `RetryExhaustedError` | reasks ran out | `attempts`, `lastError` (Zod issues), cumulative `usage` |
| `OutputTruncatedError` | provider cut the response | `reason` (the marker), `raw`, `attempts`, `usage`, `cause` |
| `TokenBudgetExceeded` | budget reached, loop stops | the cumulative `usage` |
| `TokenUsageUnavailableError` | no usage to measure against | — (fail closed) |
| `DocumentChunkError` | one chunk failed | chunk `index`, its `startIndex`/`endIndex` window |
| `DocumentConflictError` | `onConflict: "error"` fired | every field, both values, the window each was read from |
| `DocumentMergeError` | merged output failed `schema` | Zod `issues`, the invalid `partial`, `chunkErrors` |
| `DocumentNoDataError` | nothing produced a value | `reason`, `chunkErrors`, `usage` already spent |
| `DocumentInterruptedError` | timeout / abort / budget cut the run | `partial` (best-effort merge), per-chunk `chunks`, `usage`, `cause` |

`DocumentInterruptedError` is the sharpest expression of the principle: an
interrupted run of a 100-chunk document at chunk 60 does not discard 60 chunks
of paid output. The error *is* the result, marked provisional.

## Entry points and dependencies

The public surface is three entry points, and their separation is the
dependency policy:

| Entry point | Pulls in | Optional peer |
|---|---|---|
| `@tomnio/rubric` | the core loop, modes, streaming | provider SDKs |
| `@tomnio/rubric/document` | + chunker + merge | `@chonkiejs/core` (WASM) |
| `@tomnio/rubric/pdf` | + text extraction | `unpdf` |

The heavy weights — a WASM chunker, a PDF parser with a native canvas
dependency — sit behind dynamic imports in their own subpaths. Calling
`create()` installs and loads none of them. Both peers are optional with an
install hint when absent, and `unpdf` is pinned `<1.8` because 1.8+ declares
`node >= 22` while this package supports Node 20.

The single runtime dependency is `partial-json`, used by streaming to parse
incomplete frames as they arrive.

## Testing strategy

The suite (410 offline tests) runs against hand-built fakes — no network, no
keys, no mocking framework. Fakes are plain objects implementing the one
`LLMClient` method, which is the same seam `wrap()` uses; a test that needs a
truncated response writes one by hand.

Some layers are pinned from unusual angles because the obvious angle does not
exist:

- **Type-level guarantees** (`tests/type-contracts.test.ts`): assignability
  and inference are asserted by *compiling* — a test that fails to build is
  the failing assertion.
- **Package entry points** (`tests/package-entries.test.ts`): the exports map
  is contract-tested by actually requiring `dist/` — which is why CI builds
  before testing.
- **Determinism of the benchmark generator**
  (`tests/long-document.test.ts`): the seeded document generator is itself
  tested, so the correctness study's ground truth is pinned by code, not by a
  saved fixture.

Streaming, reask composition, and every document error path have dedicated
files; the pattern is one test file per concern, named after it.

## What is deliberately not here

- **No client patching, no globals, no `AsyncLocalStorage` on the public
  surface.** Concurrency state (`context.ts`) exists, but it is internal
  plumbing for `cited()` / `llmRefine()`, invisible to callers.
- **No cache, no batch API, no CLI.** Each is a separate product concern;
  none improves the extraction guarantee.
- **No vector store / retrieval.** Single-document extraction is exhaustive
  over every character — "the model never saw it" is not a failure mode
  rubric can have, and retrieval would reintroduce it.
- **No 15-vendor matrix.** Three official SDKs plus any OpenAI-compatible
  gateway covers the reachable space; the rest is configuration.
