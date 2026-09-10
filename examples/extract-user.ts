/**
 * Live extract example. Not part of default CI.
 *
 *   OPENAI_API_KEY=... pnpm example:extract-user
 */
import OpenAI from "openai"
import { z } from "zod"
import { wrap } from "../src/index.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const apiKey = process.env["OPENAI_API_KEY"]
if (!apiKey) {
  console.error("Set OPENAI_API_KEY to run this example.")
  process.exit(1)
}

const client = wrap(new OpenAI({ apiKey }), { mode: "TOOLS" })

const user = await client.create({
  model: process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna",
  schema: User,
  messages: [{ role: "user", content: "John is 25 years old" }],
})

console.log(user)
