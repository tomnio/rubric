import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  cited,
  jsonSchemaFromZod,
  RetryExhaustedError,
  SchemaValidationError,
  wrap,
  type LLMClient,
} from "../src/index.js"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.js"

const SOURCE =
  "Jason Liu grew up in Toronto, Canada but was born in China.\n" +
  "He worked at Stitchfix and Facebook as part of coop programs."

const Fact = cited(
  z.object({
    statement: z.string(),
  }),
)

function toolResponse(payload: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: EXTRACT_TOOL_NAME,
                arguments: JSON.stringify(payload),
              },
            },
          ],
        },
      },
    ],
  }
}

function fakeClient(response: unknown): LLMClient {
  return {
    async chatCompletionsCreate() {
      return response
    },
  }
}

describe("cited", () => {
  it("keeps an exact quote and returns the source substring", async () => {
    const quote = "He worked at Stitchfix and Facebook"
    const client = wrap(
      fakeClient(toolResponse({ statement: "Jason worked at Stitchfix", substring_quotes: [quote] })),
    )

    const value = await client.create({
      model: "test-model",
      schema: Fact,
      messages: [{ role: "user", content: SOURCE }],
      context: SOURCE,
    })

    expect(value.substring_quotes).toEqual([quote])
  })

  it("rewrites a whitespace/case variant to the exact source span", async () => {
    const client = wrap(
      fakeClient(
        toolResponse({
          statement: "Jason was born in China",
          // Newline collapsed to a space, "China" lowercased.
          substring_quotes: ["born in china. he worked"],
        }),
      ),
    )

    const value = await client.create({
      model: "test-model",
      schema: Fact,
      messages: [{ role: "user", content: SOURCE }],
      context: SOURCE,
    })

    expect(value.substring_quotes).toEqual(["born in China.\nHe worked"])
  })

  it("reasks when a quote is not in the context", async () => {
    const calls: Array<{ messages: unknown }> = []
    const client = wrap({
      async chatCompletionsCreate(kwargs) {
        calls.push({ messages: kwargs.messages })
        if (calls.length === 1) {
          return toolResponse({
            statement: "Jason studied physics",
            substring_quotes: ["He studied Computational Mathematics"],
          })
        }
        return toolResponse({
          statement: "Jason worked at Stitchfix",
          substring_quotes: ["He worked at Stitchfix and Facebook"],
        })
      },
    })

    const value = await client.create({
      model: "test-model",
      schema: Fact,
      messages: [{ role: "user", content: SOURCE }],
      context: SOURCE,
    })

    expect(calls).toHaveLength(2)
    expect(value.substring_quotes).toEqual(["He worked at Stitchfix and Facebook"])

    // TOOLS reask replies with a `tool` message carrying the validation error.
    const secondMessages = calls[1]?.messages as Array<{ role: string; content: string }>
    const last = secondMessages.at(-1)
    expect(last?.role).toBe("tool")
    expect(last?.content).toMatch(/not a substring of the provided context/)
    expect(last?.content).toMatch(/substring_quotes\.0/)
  })

  it("throws RetryExhaustedError when a quote never matches", async () => {
    const client = wrap(
      fakeClient(
        toolResponse({
          statement: "Invented",
          substring_quotes: ["This sentence is not in the source"],
        }),
      ),
    )

    const error = await client
      .create({
        model: "test-model",
        schema: Fact,
        messages: [{ role: "user", content: SOURCE }],
        context: SOURCE,
        maxRetries: 0,
      })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(RetryExhaustedError)
    const exhausted = error as RetryExhaustedError
    expect(exhausted.attempts).toBe(1)
    const lastError = exhausted.lastError as SchemaValidationError
    expect(lastError.issues[0]?.path).toEqual(["substring_quotes", 0])
  })

  it("reports the index of the offending quote", async () => {
    const client = wrap(
      fakeClient(
        toolResponse({
          statement: "Two quotes",
          substring_quotes: ["Jason Liu grew up in Toronto", "fabricated second quote"],
        }),
      ),
    )

    const error = (await client
      .create({
        model: "test-model",
        schema: Fact,
        messages: [{ role: "user", content: SOURCE }],
        context: SOURCE,
        maxRetries: 0,
      })
      .catch((err: unknown) => err)) as RetryExhaustedError

    const lastError = error.lastError as SchemaValidationError
    expect(lastError.issues).toHaveLength(1)
    expect(lastError.issues[0]?.path).toEqual(["substring_quotes", 1])
  })

  it("passes quotes through untouched when no context is given", async () => {
    const client = wrap(
      fakeClient(
        toolResponse({
          statement: "Anything",
          substring_quotes: ["not verified against any source"],
        }),
      ),
    )

    const value = await client.create({
      model: "test-model",
      schema: Fact,
      messages: [{ role: "user", content: "no source text" }],
    })

    expect(value.substring_quotes).toEqual(["not verified against any source"])
  })

  it("adds the quotes field without mutating the base schema", () => {
    const Base = z.object({ statement: z.string() })
    const WithQuotes = cited(Base)

    expect("substring_quotes" in Base.shape).toBe(false)
    expect(jsonSchemaFromZod(Base).properties).not.toHaveProperty("substring_quotes")
    expect(jsonSchemaFromZod(WithQuotes).properties).toHaveProperty("substring_quotes")
  })

  it("keeps concurrent calls with different contexts isolated", async () => {
    // Both calls parse at the same time with different sources. A shared
    // module-global context would let one call read the other's source.
    const alpha = "Alpha was a student in Toronto."
    const beta = "Beta worked at Stitchfix and Facebook."

    const slowClient = (quote: string): LLMClient => ({
      async chatCompletionsCreate() {
        // Yield so the two parses interleave inside the validator.
        await new Promise((resolve) => setTimeout(resolve, 5))
        return toolResponse({ statement: "x", substring_quotes: [quote] })
      },
    })

    const [a, b] = await Promise.all([
      wrap(slowClient("Alpha was a student")).create({
        model: "test-model",
        schema: Fact,
        messages: [{ role: "user", content: alpha }],
        context: alpha,
      }),
      wrap(slowClient("Beta worked at Stitchfix")).create({
        model: "test-model",
        schema: Fact,
        messages: [{ role: "user", content: beta }],
        context: beta,
      }),
    ])

    expect(a.substring_quotes).toEqual(["Alpha was a student"])
    expect(b.substring_quotes).toEqual(["Beta worked at Stitchfix"])
  })

  it("keeps working when the base schema has a refine", async () => {
    const Strict = cited(
      z.object({
        statement: z.string().refine((s) => s.length > 3, { message: "too short" }),
      }),
    )
    const client = wrap(
      fakeClient(toolResponse({ statement: "Jason", substring_quotes: ["Jason Liu grew up"] })),
    )

    const value = await client.create({
      model: "test-model",
      schema: Strict,
      messages: [{ role: "user", content: SOURCE }],
      context: SOURCE,
    })

    expect(value.statement).toBe("Jason")
    expect(value.substring_quotes).toEqual(["Jason Liu grew up"])
  })
})
