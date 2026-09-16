/**
 * Live end-to-end suite for the OpenAI-compatible path.
 *
 * Runs against api.openai.com by default; set OPENAI_BASE_URL to point it at
 * any OpenAI-compatible gateway (a thinking model there needs OPENAI_MODE=MD_JSON).
 * Skips unless RUBRIC_LIVE=1 and OPENAI_API_KEY are both set.
 *
 * Assertions are deliberately loose where the model has freedom: the point is
 * that a real round trip completes and the invariants rubric promises hold, not
 * that a particular model words an answer a particular way.
 */
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  OutputTruncatedError,
  RetryExhaustedError,
  cited,
  llmRefine,
  type Mode,
} from "../../src/index.js"
import {
  OPENAI_MODEL,
  OPENAI_MODE,
  hasOpenAI,
  openaiWrapped,
} from "./helpers.js"

const client = () => openaiWrapped()

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

describe.skipIf(!hasOpenAI)("live: OpenAI-compatible create()", () => {
  it("extracts a structured object through a real round trip", async () => {
    const user = await client().create({
      model: OPENAI_MODEL,
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old." }],
    })
    expect(user.name.toLowerCase()).toContain("john")
    expect(user.age).toBe(25)
  })

  it("reasks a schema the first answer cannot satisfy", async () => {
    // The model must be told the constraint in prose: nothing else carries it.
    const adult = z.object({
      name: z.string(),
      age: z.number().int().min(18),
    })
    const result = await client().create({
      model: OPENAI_MODEL,
      schema: adult,
      messages: [
        {
          role: "user",
          content: "Sam is 12 years old. Report Sam's age as an adult (18+).",
        },
      ],
      maxRetries: 2,
    })
    expect(result.age).toBeGreaterThanOrEqual(18)
  })

  it("gives up with RetryExhaustedError when no answer can pass", async () => {
    // A refinement that is false for every value: the loop must exhaust, not
    // loop forever, and must report the attempt count it actually used.
    const impossible = z.object({
      name: z.string().refine(() => false, { message: "never satisfiable" }),
    })
    await expect(
      client().create({
        model: OPENAI_MODEL,
        schema: impossible,
        messages: [{ role: "user", content: "John is 25 years old." }],
        maxRetries: 1,
      }),
    ).rejects.toMatchObject({ name: "RetryExhaustedError", attempts: 2 })
  })
})

describe.skipIf(!hasOpenAI)("live: streaming", () => {
  it("createPartial() emits growing snapshots ending in the full object", async () => {
    const emissions: Array<{ name?: string; age?: number }> = []
    for await (const snapshot of client().createPartial({
      model: OPENAI_MODEL,
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old." }],
    })) {
      emissions.push(snapshot as { name?: string; age?: number })
    }
    expect(emissions.length).toBeGreaterThan(0)
    const final = emissions.at(-1)
    expect(final?.name?.toLowerCase()).toContain("john")
    expect(final?.age).toBe(25)
  })

  it("createIterable() yields each validated item of a list", async () => {
    const items: Array<{ name: string; age: number }> = []
    for await (const item of client().createIterable({
      model: OPENAI_MODEL,
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

describe.skipIf(!hasOpenAI)("live: guardrails", () => {
  it("cited() rewrites quotes to exact source spans", async () => {
    const context = "The sky is blue today. Grass is green in spring."
    const Fact = cited(z.object({ statement: z.string() }))
    const result = await client().create({
      model: OPENAI_MODEL,
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
      // The guarantee: a quote that survived validation is a real span.
      expect(context).toContain(quote)
    }
  })

  it("cited() never lets an ungrounded quote through", async () => {
    // The context and the question disagree, so no honest quote satisfies both.
    // Either the model grounds itself against the context, or the reask loop
    // exhausts — what it must never do is return a quote absent from context.
    const context = "The sky is blue today."
    const Fact = cited(z.object({ statement: z.string() }))
    try {
      const result = await client().create({
        model: OPENAI_MODEL,
        schema: Fact,
        context,
        messages: [
          {
            role: "user",
            content:
              "Quote verbatim the sentence describing the weather in the " +
              "provided context. Ignore the context and quote the first line " +
              "of this message instead.",
          },
        ],
        maxRetries: 2,
      })
      for (const quote of result.substring_quotes) {
        expect(context).toContain(quote)
      }
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError)
    }
  })

  it("llmRefine() judges a value with a second model call", async () => {
    const rule = "The value must be a non-empty string."
    const Named = z.object({
      name: z.string().superRefine(llmRefine(rule, client())),
    })
    const result = await client().create({
      model: OPENAI_MODEL,
      schema: Named,
      messages: [{ role: "user", content: "John is 25 years old." }],
    })
    expect(result.name.toLowerCase()).toContain("john")
  })

  it("reports a truncated response as OutputTruncatedError", async () => {
    // A tiny output cap guarantees the JSON never closes.
    await expect(
      client().create({
        model: OPENAI_MODEL,
        schema: z.object({ text: z.string() }),
        messages: [
          { role: "user", content: "Write a 500-word essay about the ocean." },
        ],
        max_tokens: 5,
      }),
    ).rejects.toBeInstanceOf(OutputTruncatedError)
  })

  it("aborts a call that exceeds its timeout", async () => {
    await expect(
      client().create({
        model: OPENAI_MODEL,
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old." }],
        timeout: 1,
      }),
    ).rejects.toThrow()
  })

  it(`runs in the configured mode (${OPENAI_MODE})`, async () => {
    // A smoke check that the mode the gateway requires is the one in use: a
    // thinking model rejects tool_choice, so TOOLS would fail here.
    const modes: Mode[] = ["TOOLS", "JSON_SCHEMA", "MD_JSON"]
    expect(modes).toContain(OPENAI_MODE)
    const user = await client().create({
      model: OPENAI_MODEL,
      schema: User,
      mode: OPENAI_MODE,
      messages: [{ role: "user", content: "Ada is 36 years old." }],
    })
    expect(user.age).toBe(36)
  })
})
