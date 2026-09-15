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
| **Hooks** | `onRequest` / `onParseError` / `onSuccess` / `onUsage` (token totals across reasks) |
| **Stream** | `createPartial()` incomplete objects; `createIterable()` complete list items |
| **Images** | `imageUrl(url)` in `messages[].content` (Anthropic maps these to `image` / `source`) |

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
  temperature: 0,
  max_tokens: 1024,
  top_p: 1,
  signal: AbortSignal.timeout(10_000),
})
```

`maxRetries: 0` means one attempt. Exhausted retries throw `RetryExhaustedError`. Network / SDK errors are not retried.

### Modes

| Mode | Schema on the wire | JSON from |
|---|---|---|
| `TOOLS` | `tools` + `tool_choice` | `tool_calls[].function.arguments` |
| `JSON_SCHEMA` | `response_format.json_schema` | `message.content` |
| `MD_JSON` | system prompt + markdown fence | fenced JSON, else raw content |
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
    onRequest(kwargs) {},
    onParseError(error) {},
    onSuccess(value) {},
    onUsage(usage) {},
  },
})
```

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

## License

MIT
