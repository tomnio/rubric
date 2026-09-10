# Rubric

Schema-first structured extraction from LLMs.

You hand the model a rubric (a Zod schema). Rubric encodes that schema into the request, parses the reply, validates it, and sends the errors back until the output conforms — or retries are exhausted.

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

## Status

`wrap()` accepts a fake `LLMClient`, OpenAI `chat.completions`, or Anthropic `messages`. Modes: `TOOLS`, `JSON_SCHEMA`, `MD_JSON`, `ANTHROPIC_TOOLS`. `createPartial()` streams incomplete objects; `createIterable()` streams complete list items. Failed parses reask until `maxRetries` is exhausted.

```bash
pnpm install
pnpm typecheck
pnpm test
OPENAI_API_KEY=... pnpm example:extract-user
```

## License

MIT
