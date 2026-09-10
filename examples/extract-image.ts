/**
 * Live image extract example. Not part of default CI.
 *
 *   OPENAI_API_KEY=... IMAGE_URL=https://... pnpm example:extract-image
 */
import OpenAI from "openai"
import { z } from "zod"
import { imageUrl, wrap } from "../src/index.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const apiKey = process.env["OPENAI_API_KEY"]
const image = process.env["IMAGE_URL"]
if (!apiKey || !image) {
  console.error("Set OPENAI_API_KEY and IMAGE_URL to run this example.")
  process.exit(1)
}

const client = wrap(new OpenAI({ apiKey }), { mode: "TOOLS" })

const user = await client.create({
  model: process.env["OPENAI_MODEL"] ?? "gpt-4o-mini",
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
