# Rubric

Schema-first structured extraction from LLMs.

You define a Zod schema. Rubric puts that schema on the request, pulls JSON out of the reply, validates it, and **reasks** with the error until the value conforms — or retries run out.

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

## Features

| | |
|---|---|
| **Extract** | `create()` → `z.infer<typeof schema>` or a typed error |
| **Reask** | JSON / schema / `.refine()` failures go back to the model (`maxRetries`, default 3) |
| **Modes** | `TOOLS` (default), `JSON_SCHEMA`, `MD_JSON`, `ANTHROPIC_TOOLS`, `GEMINI_JSON` |
| **Clients** | OpenAI, Anthropic, Gemini, plus OpenAI-compatible gateways via `compatible` |
| **Lists** | `z.array(...)`; root arrays are sent as `{ items: T[] }` |
| **Zod extras** | `z.union` / `z.discriminatedUnion`, `z.record`, `z.date()` (ISO strings) |
| **Maybe** | `maybe(User)` → `{ result, error, message }` instead of throwing on a miss |
| **Citations** | `cited(User)` + `context` verifies model quotes against the source; fakes reask |
| **LLM judge** | `llmRefine("rule", client)` validates a field with a second model call |
| **Hooks** | `onRequest` / `onError` / `onParseError` / `onSuccess` / `onUsage`, each with attempt metadata |
| **Token budget** | `tokenBudget` caps cumulative tokens; the loop stops instead of reasking. `createDocument()` adds `chunkTokenBudget` and applies `tokenBudget` to the whole document |
| **Timeout** | `timeout` caps the whole call's wall-clock time, retries included |
| **Truncation** | A response cut off by `max_tokens` throws `OutputTruncatedError` instead of reasking |
| **Stream** | `createPartial()` incomplete objects (closed subtrees validated); `createIterable()` complete list items |
| **Images** | `imageUrl(url)` in `messages[].content` (Anthropic maps these to `image` / `source`) |
| **Documents** | `createDocument()` splits a long text, extracts per chunk, and merges — `@tomnio/rubric/document` |
| **Conflicts** | `onConflict: "error"` fails on a field two chunks reported differently; `dedupeBy: "sku"` merges a reworded array item instead of doubling it |

Not included: a `from_provider("vendor/model")` router, CLI, batch jobs, or cache.

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

The `./document` entry point needs one more optional peer — the WASM chunker. It is a separate import, so `create()` does not pull it in:

```bash
pnpm add @chonkiejs/core   # only for createDocument()
```

From a clone (development):

```bash
git clone git@github.com:tomnio/rubric.git
cd rubric
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Pull requests and pushes to `main` run `typecheck`, `test`, and `build` in GitHub Actions. Live examples are not part of CI.

Releases: bump `package.json` `version` on `main`, tag `vX.Y.Z` (same number), then npm. Details in [RELEASE.md](RELEASE.md).

Live extract from a clone (not in CI):

```bash
cp .env.example .env   # then set OPENAI_API_KEY
OPENAI_API_KEY=... pnpm example:extract-user
OPENAI_API_KEY=... IMAGE_URL=https://... pnpm example:extract-image
ANTHROPIC_API_KEY=... pnpm example:extract-user-anthropic
ANTHROPIC_API_KEY=... IMAGE_URL=https://... pnpm example:extract-image-anthropic
OPENAI_API_KEY=... pnpm example:extract-document   # whole document, needs @chonkiejs/core
```

Optional: `OPENAI_MODEL` (default `gpt-5.6-luna`), `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `OPENAI_BASE_URL` and `OPENAI_MODE` for a gateway (see [Providers](#providers)).

## Providers

`wrap()` inspects the client shape. It does not patch the SDK.

| Provider | Install | How to wrap | Default mode |
|---|---|---|---|
| OpenAI | `openai` | `wrap(new OpenAI())` | `TOOLS` |
| Anthropic | `@anthropic-ai/sdk` | `wrap(new Anthropic())` | `ANTHROPIC_TOOLS` |
| Google Gemini | `@google/genai` | `wrap(new GoogleGenAI({ apiKey }))` | `GEMINI_JSON` |
| DeepSeek, Groq, OpenRouter, Together, Moonshot | `openai` | `wrap(new OpenAI({ baseURL: compatible.<id>.baseURL }))` | `TOOLS` (see `compatible`) |
| Any OpenAI-compatible gateway | `openai` | `wrap(new OpenAI({ apiKey, baseURL }))` | `TOOLS` |

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

`create()` takes one prompt. `createDocument()` takes a whole **document**: it splits the text, runs the same extraction on each chunk, and merges the results into one object. It lives behind a separate entry point so that importing the core does not pull in a WASM chunker.

```bash
pnpm add @chonkiejs/core   # optional, only needed for createDocument()
```

Full working example: [`examples/extract-document.ts`](examples/extract-document.ts) (`pnpm example:extract-document`).

```ts
import { createDocument } from "@tomnio/rubric/document"
import { z } from "zod"

const Invoice = z.object({
  title: z.string(),
  items: z.array(z.object({ description: z.string(), amount: z.number() })),
})

// A chunk usually holds only part of the document, so validate chunks with a
// tolerant schema and keep `schema` strict for the merged result.
const ChunkInvoice = z.object({
  title: z.string().nullable().default(null),
  items: z.array(z.object({ description: z.string(), amount: z.number() })).default([]),
})

const { data, chunks, usage } = await createDocument(client, {
  model: "gpt-5.6-luna",
  document: longText,
  instruction: "Extract the invoice header and every line item.",
  schema: Invoice,
  chunkSchema: ChunkInvoice,
  chunkSize: 2000,   // characters, not tokens
  overlap: 100,      // characters bled outward on each side
  tokenBudget: 50_000, // whole document, every chunk and reask
})

data.title     // merged, validated against Invoice
chunks[0]      // { index, startIndex, endIndex, value, usage }
```

`startIndex` / `endIndex` are absolute offsets into the document you passed in, so you can trace any value back to where it came from.

`createDocument()` takes the same options as `create()` (`maxRetries`, `mode`, `temperature`, `max_tokens`, `top_p`, `signal`, `tokenBudget`, `timeout`, `hooks`) — with `tokenBudget` and `timeout` widened to the whole document — plus:

| Option | Default | Meaning |
|---|---|---|
| `document` | — | The plain text to extract from. |
| `instruction` | — | Sent to the model alongside each chunk. |
| `chunkSize` | `2000` | Target characters per chunk. |
| `overlap` | `100` | Characters bled outward on each side, for boundary recovery. |
| `chunkSchema` | `schema` | Schema used to validate each chunk. Pass a chunk-tolerant one. |
| `chunker` | Chonkie | Replace the splitter. See **Chunking** below. |
| `onChunkError` | `"skip"` | `"skip"` records the failure and continues; `"abort"` throws. |
| `chunkTokenBudget` | — | Cumulative token cap for **each** chunk, on top of `tokenBudget`. |
| `dedupe` | `"overlap"` | How to treat a repeat two chunks reported. See below. |
| `dedupeBy` | — | Field(s) that identify the same array item across chunks, so a reworded entity merges instead of doubling. See below. |
| `onConflict` | `"first"` | How to treat two chunks that reported different values for one field. See below. |

`tokenBudget` is measured across the **whole document**, not per chunk: it spans every chunk and every reask, so `tokenBudget: 50_000` on a 100-chunk document is 50k tokens total. It is checked *before* each chunk, so it blocks the next chunk rather than discarding one already paid for — a document whose final chunk crosses the budget is still returned, and the error carries the document-wide `usage`. Pass `chunkTokenBudget` as well to also cap each chunk individually; a chunk that reaches it fails and is handled by `onChunkError` like any other chunk failure. `timeout` follows the same shape: one deadline for the **whole document**, started once and shared by every chunk, so `timeout: 30_000` on a 100-chunk document is 30 seconds total rather than 30 seconds each. When the budget or the deadline cuts the run short — or the caller's `signal` aborts — the call throws `DocumentInterruptedError`, and everything extracted before the cut rides on the error: `partial` holds the completed chunks merged best-effort (not schema-validated, possibly incomplete), `chunks` holds their provenance, and `usage` the spend so far. The original interrupting error (`TimeoutError`, `AbortError`, `TokenBudgetExceeded`, `TokenUsageUnavailableError`) stays on `cause`. `maxRetries` is validated up front, before any chunk runs, so a bad value fails once with `TypeError` / `RangeError` instead of being buried in a per-chunk error.

> **Behaviour change.** `tokenBudget` on `createDocument()` used to be applied to **each chunk**; it now covers the whole document. If you were relying on a per-chunk cap, use `chunkTokenBudget`.

**Per-chunk hooks.** Hooks fire during the call, so they cannot wait for `result.chunks[]`. Every hook's `AttemptMeta` therefore carries a `chunk` descriptor for the chunk that fired it:

```ts
await createDocument(client, {
  ...,
  hooks: {
    onSuccess(_value, meta) {
      if (meta.chunk) {
        console.log(`extracted chunk ${meta.chunk.index + 1}/${meta.chunk.total}`)
      }
    },
  },
})
```

Use `meta.chunk.index`, **not** a counter you increment per hook call. `attemptNumber` counts attempts within a chunk and resets at each chunk boundary, so a chunk that reasks emits several events — a counter would report "chunk 6" for a two-chunk document. `total` is included so progress needs no up-front chunk count.

**Chunking.** The default chunker is `RecursiveChunker` from `@chonkiejs/core`, which splits on paragraph, then sentence, then punctuation. Its default tokenizer is character-based, so `chunkSize` counts **characters**. `overlap` widens each chunk's window over the original text, so content cut at a boundary still appears whole in one of the overlapping windows. Pass your own `chunker` to split differently.

A `Chunker` only **splits and positions** — it does not apply `overlap`. `createDocument()` widens whatever chunks come back, so boundary recovery works for every chunker, including one that ignores overlap entirely. `overlap` is deliberately **not** passed to a chunker (its options are just `{ chunkSize }`), because a chunker that widened its own windows would be widened a second time. If you are migrating a custom chunker that used to widen, delete that step; it now happens for you.

**Merging is deterministic and does not call the model.** The strategy follows the schema's root shape:

| Root | Rule |
|---|---|
| object | Array **fields** are concatenated across chunks; every other field takes the first non-null value seen, in chunk order. |
| array | The per-chunk arrays are concatenated the same way. |
| scalar (`z.string()`, `z.date()`, ...) | The first non-null value wins. |

**Scalar conflicts: keep the first, or fail?** "First non-null wins" is the default because chunk order roughly follows document order, so the first value is usually the one you want. But it can hide a real disagreement — the document may say one thing in one place and another later, and the default reports neither. Pass `onConflict: "error"` to throw `DocumentConflictError` instead, listing every field the chunks disagreed on and every value each one reported (with the window it was read from):

```ts
try {
  await createDocument(client, { ..., onConflict: "error" })
} catch (err) {
  if (err instanceof DocumentConflictError) {
    for (const c of err.conflicts) {
      console.log(c.key, c.values)   // [{ value, startIndex, endIndex }, ...]
    }
  }
}
```

Two chunks that **agree** are never a conflict — equality is the same structural comparison array dedupe uses, so overlapping windows that read the same text (the common case) pass. A nested object is an **atomic** value, so two different ones are a conflict; `null` counts as **absence**, not a value, so a chunk-tolerant schema (which reports unseen fields as `null`) does not conflict with a chunk that saw the field; and array fields are **exempt** — they concatenate, so there is nothing to choose between.

**Array fields: when is a repeat removed?** A value that more than one chunk reported is dropped only when those chunks' windows **overlap** — overlapping windows read the same text, so they are two views of one item. The default is `dedupe: "overlap"`:

```ts
await createDocument(client, { ..., dedupe: "none" })   // keep every repeat
```

| Case | Result |
|---|---|
| The same item inside **one** chunk | **Kept.** Windowing cannot have caused it — one window is one reading. |
| The same item in two chunks whose windows **overlap** | Counted once. This is the artifact `overlap` creates. |
| The same item in two chunks whose windows **do not** overlap | **Kept.** Two windows that share no text are two sightings. |

`dedupe: "none"` skips all of this and concatenates. Use it when the document may legitimately repeat an item (two identical invoice lines) and you would rather see a duplicate than lose one.

**Entity keys: merging a reworded item.** The rules above compare whole values, so an entity the model **reworded** across a boundary — `{ sku: "A1", desc: "Coffee" }` in one chunk, `{ sku: "A1", price: 5 }` in the next — is deep-unequal and survives twice, each copy holding half the fields. Name the field that identifies the entity to have the merge recognise the two readings as one item and **union their fields**:

```ts
await createDocument(client, { ..., dedupeBy: "sku" })          // or ["region", "sku"]
// → items: [{ sku: "A1", desc: "Coffee", price: 5 }]
```

Each field the first reading is missing is filled from the later one; a field both saw keeps the **first** non-null value, the same rule a scalar field follows. `dedupe` still applies — two readings merge only when their windows overlap. An item missing any named field, or holding it as `null`, is not identifiable and falls back to whole-value equality: it stays a separate item rather than being folded into one it may not match. The option is off by default, so it is purely additive.

What this means in practice:

- A value **reworded** in two chunks (same meaning, different text) is *not* merged — you get both, unless you name an entity key with `dedupeBy`.
- A conflicting scalar keeps the **first** value and silently discards the later one (unless you pass `onConflict: "error"`).
- A record longer than `overlap` that straddles a boundary can still be lost.
- **Known limit:** two genuine duplicates that happen to sit in two *overlapping* chunks are still collapsed — overlapping windows leave no signal to tell them apart from an overlap repeat. Use `dedupe: "none"` if that matters.

**Deep equality** compares type and content, so `z.date()`, `Map`, `Set` and `RegExp` values are compared as values: two `Date`s are equal only if they hold the same instant, and `NaN` is distinct from `null`. A value with no structural form — a class instance, a function — is opaque and equal only to itself, so an unrecognised duplicate survives rather than a distinct value disappearing.

There is deliberately no LLM "reduce" pass. A second, unvalidated model call would be nondeterministic and would reopen the failure modes `create()` exists to close.

**Failures.** A chunk that exhausts its retries is recorded on `chunks[i].error` and skipped by default; the rest of the document still merges. Pass `onChunkError: "abort"` to throw on the first failure instead. An aborted `signal` always propagates.

**Interruptions.** A `signal` abort, an elapsed `timeout`, or an exhausted document `tokenBudget` stops the run mid-way. Nothing already extracted is lost: the call throws `DocumentInterruptedError`, whose `partial` is the completed chunks merged best-effort (not schema-validated, possibly incomplete — treat as provisional), whose `chunks` carries their provenance, and whose `usage` the spend so far. The original error (`AbortError`, `TimeoutError`, `TokenBudgetExceeded`, `TokenUsageUnavailableError`) is on `cause`.

**Nothing succeeded** — every chunk failed, or the document was blank so no chunk ran — throws `DocumentNoDataError`, which carries `reason` (`"all-chunks-failed"` or `"empty-document"`), the `chunkErrors`, and the `usage` already spent. A blank document with an all-optional schema is not a valid empty answer; it is a question that was never asked. Only one chunk needs to succeed for the normal return.

**Merged output that fails `schema`** (a required field in no chunk, or two chunks contributing incompatible values) throws `DocumentMergeError`, which carries `issues`, the invalid `partial` object, and any `chunkErrors`. This is a different failure from `DocumentNoDataError`: the chunks *did* produce values, so the problem is their combination.

**Cost.** Each chunk is a separate `create()` call, so a document of N chunks costs N calls — up to `N × (maxRetries + 1)`. `tokenBudget` caps the total across all of them; `chunkTokenBudget` caps any one of them.

Requires Node 20+. The chunker is a WASM module, so it does not run on older Node.

## Live tests

The test suite runs entirely against fake clients — no network, and it passes with no API key. A separate, opt-in suite makes real SDK round trips to prove the adapters, the reask loop, the citation guardrail and the document pipeline work end to end:

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
