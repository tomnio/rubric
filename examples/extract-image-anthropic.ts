/**
 * Live Anthropic image extract example. Not part of default CI.
 *
 *   ANTHROPIC_API_KEY=... IMAGE_URL=https://... pnpm example:extract-image-anthropic
 */
import Anthropic from "@anthropic-ai/sdk"
import { z } from "zod"
import { imageUrl, wrap } from "../src/index.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const apiKey = process.env["ANTHROPIC_API_KEY"]
const image = process.env["IMAGE_URL"]
if (!apiKey || !image) {
  console.error("Set ANTHROPIC_API_KEY and IMAGE_URL to run this example.")
  process.exit(1)
}

const client = wrap(new Anthropic({ apiKey }))

const user = await client.create({
  model: process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6",
  schema: User,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Extract the person in this image." },
        imageUrl(image),
      ],
    },
  ],
})

console.log(user)
