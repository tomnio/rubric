import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { wrap } from "../src/index.ts"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.ts"

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

describe("OpenAI adapter", () => {
  it("calls chat.completions.create and returns a typed object", async () => {
    const create = vi.fn(async (_body: unknown) =>
      toolResponse({ name: "John", age: 25 }),
    )
    const openai = { chat: { completions: { create } } }
    const originalCreate = openai.chat.completions.create

    const client = wrap(openai)
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })

    expect(user).toEqual({ name: "John", age: 25 })
    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0]?.[0] as unknown as {
      model: string
      tools: unknown
    }
    expect(body.model).toBe("test-model")
    expect(body.tools).toBeDefined()
    expect(openai.chat.completions.create).toBe(originalCreate)
  })

  it("still accepts a fake LLMClient", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        return toolResponse({ name: "John", age: 25 })
      },
    })
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
  })
})
