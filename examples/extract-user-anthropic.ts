/**
 * Live Anthropic extract example. Not part of default CI.
 *
 *   ANTHROPIC_API_KEY=... pnpm example:extract-user-anthropic
 */
import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"
import { wrap } from "../src/index.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const apiKey = process.env["ANTHROPIC_API_KEY"]
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY to run this example.")
  process.exit(1)
}

const client = wrap(new Anthropic({ apiKey }))

const user = await client.create({
  model: process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6",
  schema: User,
  messages: [{ role: "user", content: "John is 25 years old" }],
})

console.log(user)
