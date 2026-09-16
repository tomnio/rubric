/**
 * Live end-to-end suite for the Anthropic path.
 *
 * Proves the native `messages` adapter works against a real Claude model,
 * including the tool-use mode it defaults to and its streaming shape. Skips
 * unless RUBRIC_LIVE=1 and ANTHROPIC_API_KEY are both set.
 */
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { cited } from "../../src/index.js"
import { ANTHROPIC_MODEL, anthropicWrapped, hasAnthropic } from "./helpers.js"

const client = () => anthropicWrapped()

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

describe.skipIf(!hasAnthropic)("live: Anthropic create()", () => {
  it("extracts a structured object through a real round trip", async () => {
    const user = await client().create({
      model: ANTHROPIC_MODEL,
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old." }],
    })
    expect(user.name.toLowerCase()).toContain("john")
    expect(user.age).toBe(25)
  })

  it("rewrites citation quotes to exact source spans", async () => {
    const context = "The sky is blue today. Grass is green in spring."
    const Fact = cited(z.object({ statement: z.string() }))
    const result = await client().create({
      model: ANTHROPIC_MODEL,
      schema: Fact,
      context,
      messages: [
        {
          role: "user",
          content: `Extract one fact and quote it verbatim from this text:\n\n${context}`,
        },
      ],
    })
    expect(result.substring_quotes.length).toBeGreaterThan(0)
    for (const quote of result.substring_quotes) {
      expect(context).toContain(quote)
    }
  })
})

describe.skipIf(!hasAnthropic)("live: Anthropic streaming", () => {
  it("createIterable() yields each validated item of a list", async () => {
    const items: Array<{ name: string; age: number }> = []
    for await (const item of client().createIterable({
      model: ANTHROPIC_MODEL,
      schema: z.object({ name: z.string(), age: z.number().int() }),
      messages: [
        {
          role: "user",
          content: "List three people, each with a name and an age.",
        },
      ],
    })) {
      items.push(item as { name: string; age: number })
    }
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(typeof item.name).toBe("string")
      expect(Number.isInteger(item.age)).toBe(true)
    }
  })
})
