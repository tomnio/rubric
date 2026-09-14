import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { wrap, type LLMClient } from "../src/index.js"

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

describe("AbortSignal", () => {
  it("throws if the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const client = wrap({
      async chatCompletionsCreate() {
        return toolResponse({ name: "John", age: 25 })
      },
    } satisfies LLMClient)

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25" }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  it("passes signal as the second argument to OpenAI create", async () => {
    const controller = new AbortController()
    const create = vi.fn(async (_body: unknown, _opts?: { signal?: AbortSignal }) =>
      toolResponse({ name: "John", age: 25 }),
    )
    const client = wrap({ chat: { completions: { create } } })
    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
      signal: controller.signal,
    })
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal })
  })

  it("does not pass a second argument when signal is omitted", async () => {
    const create = vi.fn(async (_body: unknown, _opts?: { signal?: AbortSignal }) =>
      toolResponse({ name: "John", age: 25 }),
    )
    const client = wrap({ chat: { completions: { create } } })
    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
    })
    expect(create.mock.calls[0]?.[1]).toBeUndefined()
  })
})
