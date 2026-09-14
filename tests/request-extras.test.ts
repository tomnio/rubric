import { describe, expect, it } from "vitest"
import { z } from "zod"
import { wrap, type LLMClient, type RequestKwargs } from "../src/index.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

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
                name: "extract",
                arguments: JSON.stringify(payload),
              },
            },
          ],
        },
      },
    ],
  }
}

describe("request extras", () => {
  it("forwards temperature, max_tokens, and top_p", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap({
      async chatCompletionsCreate(kwargs) {
        capture.push(kwargs)
        return toolResponse({ name: "John", age: 25 })
      },
    } satisfies LLMClient)

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
      temperature: 0,
      max_tokens: 256,
      top_p: 0.9,
    })

    expect(capture[0]?.temperature).toBe(0)
    expect(capture[0]?.max_tokens).toBe(256)
    expect(capture[0]?.top_p).toBe(0.9)
  })

  it("keeps extras on reask", async () => {
    const capture: RequestKwargs[] = []
    let calls = 0
    const client = wrap({
      async chatCompletionsCreate(kwargs) {
        capture.push(kwargs)
        calls += 1
        if (calls === 1) {
          return toolResponse({ name: "John", age: "x" })
        }
        return toolResponse({ name: "John", age: 25 })
      },
    } satisfies LLMClient)

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
      temperature: 0.2,
    })

    expect(capture).toHaveLength(2)
    expect(capture[1]?.temperature).toBe(0.2)
  })

  it("overrides Anthropic default max_tokens", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      {
        async chatCompletionsCreate(kwargs) {
          capture.push(kwargs)
          return {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "extract",
                input: { name: "John", age: 25 },
              },
            ],
          }
        },
      } satisfies LLMClient,
      { mode: "ANTHROPIC_TOOLS" },
    )

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
      max_tokens: 50,
    })

    expect(capture[0]?.max_tokens).toBe(50)
  })

  it("uses wrap() sampling defaults and lets create() override", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      {
        async chatCompletionsCreate(kwargs) {
          capture.push(kwargs)
          return toolResponse({ name: "John", age: 25 })
        },
      } satisfies LLMClient,
      { temperature: 0, max_tokens: 128, top_p: 1 },
    )

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
    })
    expect(capture[0]?.temperature).toBe(0)
    expect(capture[0]?.max_tokens).toBe(128)
    expect(capture[0]?.top_p).toBe(1)

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
      temperature: 0.7,
    })
    expect(capture[1]?.temperature).toBe(0.7)
    expect(capture[1]?.max_tokens).toBe(128)
  })
})
