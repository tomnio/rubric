# Rubric

[![npm](https://img.shields.io/npm/v/@tomnio/rubric)](https://www.npmjs.com/package/@tomnio/rubric)
[![CI](https://github.com/tomnio/rubric/actions/workflows/ci.yml/badge.svg)](https://github.com/tomnio/rubric/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-20%2B-brightgreen)
![zod](https://img.shields.io/badge/zod-3%20%7C%204-blue)

Schema-first structured extraction from LLMs. You define a Zod schema. Rubric puts that schema on the request, pulls JSON out of the reply, validates it, and **reasks** with the error until the value conforms — or retries run out. For documents longer than the context window, `createDocument()` splits the text, extracts per chunk, and merges — measured to recover **100% of planted entities at a 0% duplicate rate** where a single call over the same document returns nothing ([benchmarks](docs/benchmarks.md)).

[Releases](https://github.com/tomnio/rubric/releases) · [CHANGELOG](CHANGELOG.md) · [Contributing](CONTRIBUTING.md)

```ts
import OpenAI from "openai"
import { z } from "zod"
import { wrap } from "@tomnio/rubric"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const client = wrap(new OpenAI(), { mode: "TOOLS" })

const user = await client.create({
  model: "gpt-5.6-luna",
  schema: User,
  messages: [{ role: "user", content: "John is 25 years old" }],
})
// { name: "John", age: 25 }
```

`wrap()` does not patch the SDK. The original client is unchanged.

## Why

Getting structured data out of an LLM has three failure layers, and most tooling stops at the first:

1. **One call can't be trusted.** Models miss schema fields, drift on formats, invent values. Rubric closes this loop: schema on the request, validation on the reply, reask with the error — so `create()` returns `z.infer<typeof schema>` or a typed error, never a guess.
2. **Real documents don't fit in the prompt.** Contracts, filings, and reports run past the context window. A single call truncates silently or dies on the output limit. `createDocument()` chunks the text, extracts per chunk, and merges — with the machinery that makes chunking lossless: overlap-aware dedupe, entity-key merging (`dedupeBy`) for items that cross chunk boundaries, conflict detection (`onConflict`) for fields the document states differently in different places, and partial results on interruption so paid-for chunks come back even when the run is cut short.
3. **You have to trust the pipeline itself.** A chunk-and-merge layer is easy to doubt: does it drop data? double it? Silently pick one side of a contradiction? Rubric answers with measurement — a seeded generator plants exactly-known entities (including adversarial pairs split across chunk boundaries and a planted scalar conflict), and the scored runs show 100% recall and 0% duplicates at 56 and 151 pages, where the naive call collapses to 0% past the limit. See [docs/benchmarks.md](docs/benchmarks.md).

## Why not the alternatives

- **Provider-native structured output** (OpenAI JSON mode / strict schema, Anthropic tool use, Gemini responseSchema) puts the schema on the request — that is layer 1 solved at the wire level. But there is no retry loop: a reply that misses the schema is your error to handle. There is also no document story: a contract past the context window is still your problem. Rubric wraps those same wire formats (that is what the modes are) and closes the loop around them.
- **Python Instructor** (and ports of it) owns the reask loop. Rubric takes the same idea, in TypeScript with Zod, and adds the part none of them have: the document pipeline — chunking, overlap-aware dedupe, entity-key merging, conflict detection, partial results on interruption, per-chunk provenance — with a measured no-loss claim rather than a hoped-for one.
- **Framework extraction chains** (LangChain-style parsers, or a RAG pipeline) handle long inputs by retrieving *relevant* pieces and answering from those. That is a different product: it optimizes for a good-enough answer, and it can silently miss the pieces it never retrieved. Rubric does not retrieve — it processes every character, so "the model never saw it" is not a failure mode it can have. For single-document extraction, exhaustive beats selective.

The short version: if your input fits in one prompt and one try always works, you do not need this library. The gap starts where provider-native output ends.

## Guarantees

Each of these is implemented, typed, and covered by tests:

| Guarantee | How |
|---|---|
| **Validated output or a typed error** — never an unvalidated guess | `create()` returns `z.infer<S>` or throws a typed error; failures reask with the parse error attached |
| **Truncation is surfaced, not papered over** | A response cut by `max_tokens` throws `OutputTruncatedError` instead of reasking into a dead end |
| **Long-document extraction loses nothing** | 100% recall / 0% duplicates at 56 and 151 pages ([benchmarks](docs/benchmarks.md)) |
| **Items reworded across chunk boundaries merge back into one** | `dedupeBy` entity-key merge with field union |
| **A field stated differently in two places is detected** | `onConflict: "error"` names the field, both values, and the windows they came from |
| **Interrupted runs return what you paid for** | Timeout / abort / budget cuts throw `DocumentInterruptedError` carrying `partial`, per-chunk provenance, and usage |
| **Every value traces to its source** | `cited()` verifies quotes against the context; document results carry per-chunk absolute offsets |
| **Spend is bounded** | `tokenBudget` (per call / whole document) stops the loop and returns what completed |
| **Time is bounded** | `timeout` caps the whole call's wall clock, retries included; streaming entries reject it |

## Features

| | |
|---|---|
| **Extract** | `create()` → `z.infer<typeof schema>` or a typed error |
| **Reask** | JSON / schema / `.refine()` failures go back to the model (`maxRetries`, default 3) |
| **Modes** | `TOOLS` (default), `JSON_SCHEMA`, `MD_JSON`, `ANTHROPIC_TOOLS`, `GEMINI_JSON` |
| **Clients** | OpenAI, Anthropic, Gemini, plus OpenAI-compatible gateways via `compatible` — or `fromProvider("vendor/model")` to skip construction |
| **Lists** | `z.array(...)`; root arrays are sent as `{ items: T[] }` |
| **Zod extras** | `z.union` / `z.discriminatedUnion`, `z.record`, `z.date()` (ISO strings) |
| **Maybe** | `maybe(User)` → `{ result, error, message }` instead of throwing on a miss |
| **Citations** | `cited(User)` + `context` verifies model quotes against the source; fakes reask |
| **LLM judge** | `llmRefine("rule", client)` validates a field with a second model call |
| **Hooks** | `onRequest` / `onError` / `onParseError` / `onSuccess` / `onUsage`, each with attempt metadata |
| **Stream** | `createPartial()` incomplete objects (closed subtrees validated); `createIterable()` complete list items |
| **Images** | `imageUrl(url)` in `messages[].content` (Anthropic maps these to `image` / `source`) |
| **Documents** | `createDocument()` splits a long text, extracts per chunk, and merges — `@tomnio/rubric/document` |
| **PDF** | `extractPdfPages()` turns a PDF into per-page text for `createDocument()` — `@tomnio/rubric/pdf`, text layer only (no OCR) |

Truncation, token budget, timeout, and conflict handling are guarantees above, not features to configure. Not included: CLI, batch jobs, or cache. Measured guarantees and the evidence behind them: [docs/benchmarks.md](docs/benchmarks.md).

## Quick start

Requires Node 20+ and [pnpm](https://pnpm.io).

```bash
pnpm add @tomnio/rubric
pnpm add zod
# optional, depending on the provider:
pnpm add openai
pnpm add @anthropic-ai/sdk
pnpm add @google/genai
```

`zod` is required and works with **both Zod 3 (>= 3.24) and Zod 4**. `openai` / `@anthropic-ai/sdk` / `@google/genai` are optional peers.

The `./document` and `./pdf` entry points need one more optional peer each — the WASM chunker and the PDF text extractor. They are separate imports, so `create()` does not pull them in:

```bash
pnpm add @chonkiejs/core   # only for createDocument()
pnpm add unpdf             # only for extractPdfPages() — pin 1.7.x; 1.8+ needs Node 22
```

Runnable examples live in [`examples/`](examples/) (`pnpm example:extract-user`, `pnpm example:extract-document`, and more). Building from a clone: `pnpm install && pnpm typecheck && pnpm test && pnpm build`; release process in [RELEASE.md](RELEASE.md). Live-suite credentials are described under [Testing and reliability](#testing-and-reliability).

## Providers

`wrap()` inspects the client shape. It does not patch the SDK.

| Provider | Install | How to wrap | Default mode |
|---|---|---|---|
| OpenAI | `openai` | `wrap(new OpenAI())` | `TOOLS` |
| Anthropic | `@anthropic-ai/sdk` | `wrap(new Anthropic())` | `ANTHROPIC_TOOLS` |
| Google Gemini | `@google/genai` | `wrap(new GoogleGenAI({ apiKey }))` | `GEMINI_JSON` |
| DeepSeek, Groq, OpenRouter, Together, Moonshot | `openai` | `wrap(new OpenAI({ baseURL: compatible.<id>.baseURL }))` | `TOOLS` (see `compatible`) |
| Any OpenAI-compatible gateway | `openai` | `wrap(new OpenAI({ apiKey, baseURL }))` | `TOOLS` |

Or skip the construction and route by name with `fromProvider("vendor/model")`:

```ts
import { fromProvider } from "@tomnio/rubric"

const client = await fromProvider("deepseek/deepseek-chat", {
  apiKey: process.env.DEEPSEEK_API_KEY,
})
```

`fromProvider` loads the SDK dynamically, so only the package your vendor routes to needs to be installed. It accepts the same vendor names as the table above (`openai`, `anthropic`, `google`, plus the five compatible gateways, with or without a `/model` suffix); the model part is ignored because `create()` takes an explicit `model`. An explicit `mode` or `baseURL` in the options overrides the defaults from `compatible`.

```ts
import Anthropic from "@anthropic-ai/sdk"
import { GoogleGenAI } from "@google/genai"
import OpenAI from "openai"
import { compatible, wrap } from "@tomnio/rubric"

wrap(new OpenAI())
wrap(new Anthropic())
wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }))

wrap(
  new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: compatible.deepseek.baseURL,
  }),
  { mode: compatible.deepseek.mode },
)
```

`compatible` base URLs:

| Key | `baseURL` |
|---|---|
| `deepseek` | `https://api.deepseek.com` |
| `groq` | `https://api.groq.com/openai/v1` |
| `openrouter` | `https://openrouter.ai/api/v1` |
| `together` | `https://api.together.xyz/v1` |
| `moonshot` | `https://api.moonshot.cn/v1` |

For a custom gateway, `baseURL` must be the **`/v1` root**. The OpenAI SDK appends `/chat/completions` itself.

```ts
new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://gateway.example.com/v1",
})
```

Do **not** paste the full chat-completions URL from a vendor dashboard (`.../v1/chat/completions`). That becomes `.../v1/chat/completions/chat/completions` and typically returns **404** with an empty body.

Thinking / reasoning models (for example some DeepSeek flash variants) often reject forced `tool_choice` (`400 Thinking mode does not support this tool_choice`). Use `mode: "MD_JSON"` or a non-thinking model with `TOOLS`. Do not assume the gateway supports `JSON_SCHEMA`.

## Usage

### Wrap a client

```ts
import OpenAI from "openai"
import { wrap } from "@tomnio/rubric"

const client = wrap(new OpenAI(), {
  mode: "TOOLS",       // default
  maxRetries: 3,       // extra attempts after the first
  temperature: 0,
  max_tokens: 1024,
})
```

Tests inject a fake:

```ts
wrap({
  async chatCompletionsCreate(kwargs) {
    return { choices: [{ message: { tool_calls: [/* ... */] } }] }
  },
})
```

### `create`

```ts
const user = await client.create({
  model: "gpt-5.6-luna",
  schema: User,
  messages: [{ role: "user", content: "John is 25 years old" }],
  maxRetries: 3,       // optional, overrides wrap()
  mode: "TOOLS",       // optional
  tokenBudget: 20_000, // optional, cumulative across attempts
  timeout: 30_000,     // optional, whole call in ms, retries included
  temperature: 0,
  max_tokens: 1024,
  top_p: 1,
  signal: AbortSignal.timeout(10_000),
})
```

`maxRetries: 0` means one attempt. It must be a non-negative integer — a negative, fractional, `NaN` or infinite value throws `TypeError` / `RangeError` before the first request, rather than silently making zero attempts (or, for a fraction, rounding up to more than you wrote). Exhausted retries throw `RetryExhaustedError`; its `lastError` is `undefined` when no attempt ever ran. Network / SDK errors are not retried.

`tokenBudget` caps the **cumulative** tokens spent across every attempt. When the
running total reaches the budget the loop stops instead of reasking and throws
`TokenBudgetExceeded`. A response that already validated is still returned — the
budget blocks the next call, not the answer in hand. If a provider response
omits usage metadata the budget cannot be measured, so the call fails with
`TokenUsageUnavailableError` rather than retrying blind. Not supported by
`createPartial()` / `createIterable()` (streaming has no reask to guard).

`timeout` is a **wall-clock budget for the whole call**, in milliseconds —
retries included, not one request each. `timeout: 30_000` with `maxRetries: 3`
means 30 seconds total, not 30 seconds per attempt. When it elapses the
in-flight request is aborted and the call fails with the signal's
`TimeoutError` (name it, not a `RetryExhaustedError`: the loop was cut short, it
did not run out of attempts). It combines with `signal` — whichever fires
first wins. Unlike `tokenBudget` there is no usage requirement, so it works even
when the provider reports no token counts. Must be a positive integer, and at
most `2^31 - 1` ms: past that `AbortSignal.timeout()` does not throw, it warns
on stderr and fires after 1 ms, so the value is rejected rather than silently
inverted. Not supported by `createPartial()` / `createIterable()`.

```ts
await client.create({ model, schema: User, messages, timeout: 30_000 })
// or set it once for every call:
wrap(openai, { timeout: 30_000 })
```

#### Truncated output

When the provider stops at its output token limit, the answer is cut off, not
wrong. Rubric reads that marker from every supported wire format — OpenAI
`choices[0].finish_reason === "length"`, Anthropic `stop_reason === "max_tokens"`,
Gemini `candidates[0].finishReason === "MAX_TOKENS"` — and throws
`OutputTruncatedError` **without retrying**:

```ts
import { OutputTruncatedError } from "@tomnio/rubric"

try {
  const user = await client.create({ model, schema: User, messages, max_tokens: 64 })
} catch (error) {
  if (error instanceof OutputTruncatedError) {
    // error.reason  — the marker the provider used, e.g. "length"
    // error.raw     — the cut-off response, if you want to salvage it
    // error.usage   — tokens already spent
    // error.cause   — the JsonParseError the truncation caused
    // Retrying cannot help: the same max_tokens is cut in the same place.
    // Raise max_tokens, or ask for a smaller schema.
  }
}
```

Before this, a truncated response reached the reask loop as a JSON error and the
model was told to "return valid JSON" — advice it cannot act on, since the JSON
was never finished. `OutputTruncatedError` is deliberately **not** a
`RetryExhaustedError`: it fires on the first attempt, so `maxRetries` costs
nothing. A response that carries the marker but still validated is returned
normally; the marker means the model was stopped, not that the answer is
unusable.

For the streaming entry points a truncated stream is normal — partial output is
what they are for — so nothing is thrown when at least one snapshot or list item
arrived. Only a stream that ended with nothing to show throws
`OutputTruncatedError` instead of `JsonParseError`.

### Modes

| Mode | Schema on the wire | JSON from |
|---|---|---|
| `TOOLS` | `tools` + `tool_choice` | `tool_calls[].function.arguments` |
| `JSON_SCHEMA` | `response_format.json_schema` | `message.content` |
| `MD_JSON` | system prompt + markdown fence | last complete JSON span (fenced or raw) |
| `ANTHROPIC_TOOLS` | `input_schema` + `tool_choice` | `content[].tool_use.input` |
| `GEMINI_JSON` | `config.responseJsonSchema` | `text` or `candidates[].content.parts` |

`JSON_SCHEMA` always sends OpenAI `strict: true`. That subset is **not** Zod `.optional()`: every property must be listed in `required`, and open maps are rejected. Rubric fails **locally** in `prepareRequest` if the schema is not strict-safe (`.optional()` keys, `z.record`, non-nullable unions). Use `.nullable()` (key present, value may be `null`), or switch to `TOOLS` / `MD_JSON`. See [#23](https://github.com/tomnio/rubric/issues/23).

### Citations

`cited()` adds a `substring_quotes` field and checks each quote against the
source text you pass as `context`. A quote that is not in the source is a
validation failure, so it reasks — the model cannot cite something it made up.
Quotes that match are rewritten to the exact source substring.

```ts
import { cited } from "@tomnio/rubric"

const Fact = cited(
  z.object({
    statement: z.string().describe("A factual statement from the source"),
  }),
)

const fact = await client.create({
  model: "gpt-5.6-luna",
  schema: Fact,
  messages: [{ role: "user", content: `Extract a fact from: ${source}` }],
  context: source,
})
// { statement: "...", substring_quotes: ["... exact source substring ..."] }
```

Matching is exact, or after lowercasing and collapsing whitespace runs. Without
a `context`, the field passes through unchecked. Not supported on streaming.

### LLM-as-judge

`.refine()` covers rules you can write as code. For rules that are judgements —
"the name must be a real person", "don't say objectionable things" —
`llmRefine()` asks a second model call and turns its verdict into a Zod issue,
so a failure reasks like any other validation error.

```ts
import { llmRefine } from "@tomnio/rubric"

const Answer = z.object({
  answer: z.string().superRefine(
    llmRefine("don't say objectionable things", judgeClient),
  ),
})

await client.create({ model: "gpt-4o-mini", schema: Answer, messages })
```

The judge reuses the enclosing `create()` model unless you pass `model`. The
rule and the candidate value are sent as one JSON object, and the system prompt
tells the judge to treat both as data. A judge call that itself fails (network,
unparseable verdict) propagates as an error rather than reasking.

This is why `create()` parses with `safeParseAsync`: a judge refinement is
async, and Zod throws if an async refinement runs during a synchronous parse.

### Maybe, refine, hooks

```ts
import { maybe } from "@tomnio/rubric"

const value = await client.create({
  model: "gpt-5.6-luna",
  schema: maybe(User),
  messages: [{ role: "user", content: "It rained all afternoon." }],
})
// miss: { result: null, error: true, message: "..." }

const Adult = z.object({
  name: z.string(),
  age: z.number().int().refine((n) => n >= 18, { message: "must be 18 or older" }),
})
// refine is local (not in JSON Schema); failures reask with that message

wrap(openai, {
  hooks: {
    onRequest(kwargs, meta) {},
    onError(error, meta) {},      // provider call threw; not retried
    onParseError(error, meta) {}, // no JSON, or schema validation failed
    onSuccess(value, meta) {},
    onUsage(usage, meta) {},      // cumulative totals across reasks
  },
})
```

Every hook gets an `AttemptMeta` as its second argument:

```ts
type AttemptMeta = {
  attemptNumber: number   // 1-based, within this chunk for createDocument()
  maxAttempts: number     // maxRetries + 1
  isLastAttempt: boolean  // no further attempt will run
  chunk?: {               // present only during createDocument()
    index: number         // 0-based, document order
    startIndex: number    // absolute offsets into the document
    endIndex: number
    total: number         // how many chunks the document was split into
  }
}
```

`chunk` is filled only by `createDocument()`, where one call becomes many; a
plain `create()` leaves the key absent. See [Documents](#documents).

`isLastAttempt` is true when the loop is actually over, which includes a
guardrail stopping it early — not merely `attemptNumber === maxAttempts`. That
makes "alert on the final failure" a one-liner:

```ts
onParseError(error, meta) {
  if (meta.isLastAttempt) alert(error)
}
```

A throwing hook is reported via `console.warn` and ignored, so telemetry cannot
fail a call you already paid for.

`create({ hooks })` overrides the same keys from `wrap({ hooks })`.

### Streaming

```ts
for await (const snap of client.createPartial({ model, schema: User, messages })) {
  // { name?: string, age?: number } — incomplete snapshots
}

for await (const user of client.createIterable({ model, schema: User, messages })) {
  // full User; schema is the item type, not z.array(User)
}
```

`createPartial` validates subtrees that have finished arriving and only keeps
unfinished ones as previews, so a field that closed with a wrong type is
dropped instead of shown as data. It does not reask.

`createIterable` validates each item with the same schema — including
`cited()` against `context` and `llmRefine()` — and yields only items that pass.
An item that never validates holds back the ones after it, because the loop
cannot tell "this one is wrong" from "this one has not finished arriving".

Streaming works across all providers: OpenAI-shaped chunks (`delta.content` / tool
`arguments`), Anthropic `input_json_delta.partial_json`, and Gemini
`candidates[].content.parts` / `text` chunks.

### Images

```ts
import { imageUrl } from "@tomnio/rubric"

await client.create({
  model: "gpt-5.6-luna",
  schema: User,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "Extract the person in this image." },
      imageUrl("https://example.com/photo.jpg"),
    ],
  }],
})
```

`ANTHROPIC_TOOLS` maps `imageUrl()` to Anthropic `{ type: "image", source }`. You can also pass `anthropicImageUrl` / `anthropicImageBase64` directly.

### Documents

`create()` takes one prompt. `createDocument()` takes a whole **document**: it splits the text, runs the same extraction on each chunk, and merges the results into one object. Each chunk is a separate `create()` call — the same reask, budget, and hook machinery applies — and merging is deterministic (no model call). It lives behind a separate entry point so that importing the core does not pull in a WASM chunker.

```bash
pnpm add @chonkiejs/core   # optional, only needed for createDocument()
```

```ts
import { createDocument } from "@tomnio/rubric/document"

const { data, chunks, usage } = await createDocument(client, {
  model: "gpt-5.6-luna",
  document: longText,
  instruction: "Extract the invoice header and every line item.",
  schema: Invoice,            // strict, validates the merged result
  chunkSchema: ChunkInvoice,  // tolerant, validates each chunk
  chunkSize: 2000,            // characters, not tokens
  overlap: 100,               // characters bled outward on each side
  dedupeBy: "sku",            // reworded copies of an item merge, not double
  onConflict: "first",        // or "error" to fail on disagreeing scalars
  tokenBudget: 50_000,        // whole document, every chunk and reask
})

data.title     // merged, validated against Invoice
chunks[0]      // { index, startIndex, endIndex, value, usage } — absolute offsets
```

**Guards against the chunking failure modes:**

- **Windowing repeats** — overlapping chunks see the same text; a repeat is counted once (`dedupe`).
- **Reworded entities** — the same item paraphrased across a boundary merges into one via an entity key (`dedupeBy`), with fields unioned.
- **Conflicting scalars** — a field the document states differently in two places is detected, not silently first-wins (`onConflict: "error"` names both values and their windows).
- **Interrupted runs** — timeout / abort / budget cuts throw `DocumentInterruptedError` carrying `partial` (best-effort merge of completed chunks), per-chunk provenance, and usage.

Full option table, merge semantics, dedupe and conflict rules, per-chunk hooks, and every document error type: **[docs/document.md](docs/document.md)**. Measured correctness (100% recall / 0% duplicates at 56 and 151 pages, where the naive call returns nothing past the limit): **[docs/benchmarks.md](docs/benchmarks.md)**.

**Starting from a PDF?** [`extractPdfPages()`](examples/extract-pdf.ts) (`@tomnio/rubric/pdf`) extracts each page's text — [`joinPages()`](src/pdf/index.ts) then joins it into one `document` string while recording where each page landed, so any chunk offset `createDocument()` reports can be mapped back to its page. Text layer only: a scanned page has no text layer and yields an empty string; there is no OCR.

## Testing and reliability

The offline suite runs entirely against fake clients — 410 tests across 42 files, no network, no API key. It covers the retry loop, every mode handler, all document error paths, the merge machinery (including entity-key merging and conflict detection against hand-built outputs), generator determinism, and the package entry-point contract.

CI runs the full suite on a two-version zod matrix (3 and 4) on every push and pull request; releases are tagged, signed, and published by workflow. Everything shipped is on npm as `@tomnio/rubric` ([releases](https://github.com/tomnio/rubric/releases)).

A separate, opt-in suite makes real SDK round trips to prove the adapters, the reask loop, the citation guardrail and the document pipeline work end to end:

```bash
pnpm test:live
```

It is off unless both conditions hold: `RUBRIC_LIVE=1` (the script sets it) **and** the provider's key is present. Without a key the relevant suite skips, so `pnpm test` and CI never reach the network.

Put credentials in a `.env` at the package root — gitignored, and read only by the live suite — or export them in the shell:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI, or any OpenAI-compatible gateway |
| `OPENAI_BASE_URL` | Point the OpenAI suite at a gateway instead of api.openai.com |
| `OPENAI_MODEL` | Model name (default `gpt-4o-mini`) |
| `OPENAI_MODE` | `TOOLS` \| `JSON_SCHEMA` \| `MD_JSON` — a thinking model rejects `tool_choice`, so it needs `MD_JSON` |
| `ANTHROPIC_API_KEY` | Anthropic |
| `ANTHROPIC_MODEL` | Claude model (default `claude-sonnet-4-6`) |

## License

MIT
