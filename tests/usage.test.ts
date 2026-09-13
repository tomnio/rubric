import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  RetryExhaustedError,
  wrap,
  type LLMClient,
  type TokenUsage,
} from "../src/index.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

function toolResponse(
  payload: unknown,
  usage?: { prompt_tokens: number; completion_tokens: number },
): unknown {
  return {
    usage,
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

function sequenceClient(responses: unknown[]): LLMClient {
  let index = 0
  return {
    async chatCompletionsCreate() {
      const next = responses[index]
      index += 1
      return next
    },
  }
}

describe("token usage", () => {
  it("reports OpenAI usage on success", async () => {
    const onUsage = vi.fn()
    const client = wrap(
      sequenceClient([
        toolResponse(
          { name: "John", age: 25 },
          { prompt_tokens: 10, completion_tokens: 5 },
        ),
      ]),
      { hooks: { onUsage } },
    )
    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
    })
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      attempts: 1,
    } satisfies TokenUsage)
  })

  it("sums usage across a reask", async () => {
    const onUsage = vi.fn()
    const client = wrap(
      sequenceClient([
        toolResponse(
          { name: "John", age: "x" },
          { prompt_tokens: 10, completion_tokens: 4 },
        ),
        toolResponse(
          { name: "John", age: 25 },
          { prompt_tokens: 20, completion_tokens: 6 },
        ),
      ]),
      { hooks: { onUsage } },
    )
    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
    })
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0]?.[0]).toEqual({
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
      attempts: 2,
    })
  })

  it("reads Anthropic input_tokens / output_tokens", async () => {
    const onUsage = vi.fn()
    const client = wrap(
      sequenceClient([
        {
          usage: { input_tokens: 7, output_tokens: 3 },
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "extract",
              input: { name: "John", age: 25 },
            },
          ],
        },
      ]),
      { mode: "ANTHROPIC_TOOLS", hooks: { onUsage } },
    )
    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
    })
    expect(onUsage.mock.calls[0]?.[0]).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      attempts: 1,
    })
  })

  it("attaches totals on RetryExhaustedError", async () => {
    const client = wrap(
      sequenceClient([
        toolResponse(
          { name: "John" },
          { prompt_tokens: 8, completion_tokens: 2 },
        ),
      ]),
    )
    const err = await client
      .create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John" }],
        maxRetries: 0,
      })
      .catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(RetryExhaustedError)
    expect((err as RetryExhaustedError).usage).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 10,
      attempts: 1,
    })
  })
})
