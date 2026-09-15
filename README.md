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
| **Token budget** | `tokenBudget` caps cumulative tokens; the loop stops instead of reasking |
| **Stream** | `createPartial()` incomplete objects (closed subtrees validated); `createIterable()` complete list items |
| **Images** | `imageUrl(url)` in `messages[].content` (Anthropic maps these to `image` / `source`) |
| **Documents** | `createDocument()` splits a long text, extracts per chunk, and merges — `@tomnio/rubric/document` |

Not included: a `from_provider("vendor/model")` router, CLI, batch jobs, or cache.

## Quick start

Requires Node 20+ and [pnpm](https://pnpm.io).

```bash
pnpm add @tomnio/rubric
pnpm add zod@^3.24.0
# optional, depending on the provider:
pnpm add openai
pnpm add @anthropic-ai/sdk
pnpm add @google/genai
```

`zod` is required and must be **3.x** (`^3.24.0` or `3.25.x`). Bare `pnpm add zod` currently installs Zod 4, which does not satisfy the peer range. `openai` / `@anthropic-ai/sdk` / `@google/genai` are optional peers.

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
```

Optional: `OPENAI_MODEL` (default `gpt-5.6-luna`), `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`).

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
  temperature: 0,
  max_tokens: 1024,
  top_p: 1,
  signal: AbortSignal.timeout(10_000),
})
```

`maxRetries: 0` means one attempt. Exhausted retries throw `RetryExhaustedError`. Network / SDK errors are not retried.

`tokenBudget` caps the **cumulative** tokens spent across every attempt. When the
running total reaches the budget the loop stops instead of reasking and throws
`TokenBudgetExceeded`. A response that already validated is still returned — the
budget blocks the next call, not the answer in hand. If a provider response
omits usage metadata the budget cannot be measured, so the call fails with
`TokenUsageUnavailableError` rather than retrying blind. Not supported by
`createPartial()` / `createIterable()` (streaming has no reask to guard).

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
  attemptNumber: number   // 1-based
  maxAttempts: number     // maxRetries + 1
  isLastAttempt: boolean  // no further attempt will run
}
```

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
})

data.title     // merged, validated against Invoice
chunks[0]      // { index, startIndex, endIndex, value, usage }
```

`startIndex` / `endIndex` are absolute offsets into the document you passed in, so you can trace any value back to where it came from.

**Chunking.** The default chunker is `RecursiveChunker` from `@chonkiejs/core`, which splits on paragraph, then sentence, then punctuation. Its default tokenizer is character-based, so `chunkSize` counts **characters**. `overlap` widens each chunk's window over the original text, so content cut at a boundary still appears whole in one of the overlapping windows. Pass your own `chunker` to split differently.

**Merging is deterministic and does not call the model.** The strategy follows the schema's root shape:

| Root | Rule |
|---|---|
| object | Array **fields** are concatenated across chunks and deduplicated by deep structural equality; every other field takes the first non-null value seen, in chunk order. |
| array | The per-chunk arrays are concatenated and deduplicated the same way. |
| scalar (`z.string()`, `z.date()`, ...) | The first non-null value wins. |

What this means in practice:

- Overlapping windows re-report the same item; deep equality removes the duplicate.
- A value **reworded** in two chunks (same meaning, different text) is *not* merged — you get both.
- A conflicting scalar keeps the **first** value and silently discards the later one.
- A record longer than `overlap` that straddles a boundary can still be lost.

There is deliberately no LLM "reduce" pass. A second, unvalidated model call would be nondeterministic and would reopen the failure modes `create()` exists to close.

**Failures.** A chunk that exhausts its retries is recorded on `chunks[i].error` and skipped by default; the rest of the document still merges. Pass `onChunkError: "abort"` to throw on the first failure instead. An aborted `signal` always propagates.

**Merged output that fails `schema`** (a required field in no chunk, or two chunks contributing incompatible values) throws `DocumentMergeError`, which carries `issues`, the invalid `partial` object, and any `chunkErrors`.

**Cost.** Each chunk is a separate `create()` call, so a document of N chunks costs N calls — up to `N × (maxRetries + 1)`. `tokenBudget` applies **per chunk**, not per document.

Requires Node 20+. The chunker is a WASM module, so it does not run on older Node.

## License

MIT
