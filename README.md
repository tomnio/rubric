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

Design only. No package, no runtime, no tests yet.

## License

MIT
