# Rubric

Schema-first structured extraction from LLMs.

You define a Zod schema. Rubric puts that schema on the request, pulls JSON out of the reply, validates it, and **reasks** with the error until the value conforms — or retries run out.

```ts
import OpenAI from "openai"
import { z } from "zod"
import { wrap } from "rubric"

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
| **Modes** | `TOOLS` (default), `JSON_SCHEMA`, `MD_JSON`, `ANTHROPIC_TOOLS` |
| **Clients** | Fake `LLMClient`, OpenAI `chat.completions`, Anthropic `messages` |
| **Lists** | `z.array(...)`; root arrays are sent as `{ items: T[] }` |
| **Zod extras** | `z.union` / `z.discriminatedUnion`, `z.record`, `z.date()` (ISO strings) |
| **Maybe** | `maybe(User)` → `{ result, error, message }` instead of throwing on a miss |
| **Hooks** | `onRequest` / `onParseError` / `onSuccess` |
| **Stream** | `createPartial()` incomplete objects; `createIterable()` complete list items |
| **Images** | `imageUrl(url)` in `messages[].content` |

Not included: a provider router, CLI, batch jobs, cache, or extra vendors.

## Quick start

Requires Node 20+ and [pnpm](https://pnpm.io).

```bash
git clone git@github.com:tomnio/rubric.git
cd rubric
pnpm install
pnpm typecheck
pnpm test
```

Pull requests and pushes to `main` run the same `typecheck` and `test` commands in GitHub Actions. Live examples are not part of CI.

Live extract (not in CI):

```bash
cp .env.example .env   # then set OPENAI_API_KEY
OPENAI_API_KEY=... pnpm example:extract-user
OPENAI_API_KEY=... IMAGE_URL=https://... pnpm example:extract-image
```

Optional: `OPENAI_MODEL` (default `gpt-5.6-luna`).

This repo is not published to npm yet. From another package, point at the path or import `src/index.ts`.

## Usage

### Wrap a client

```ts
import OpenAI from "openai"
import { wrap } from "rubric"

const client = wrap(new OpenAI(), {
  mode: "TOOLS",       // default
  maxRetries: 3,       // extra attempts after the first
})
```

OpenAI-shaped `chat.completions.create` is enough; the official SDK is optional. An Anthropic-shaped `messages.create` defaults to `ANTHROPIC_TOOLS`.

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

### Maybe, refine, hooks

```ts
import { maybe } from "rubric"

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

OpenAI-shaped streams only. `ANTHROPIC_TOOLS` is not supported yet.

### Images

```ts
import { imageUrl } from "rubric"

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

## License

MIT
