import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  RetryExhaustedError,
  wrap,
  type LLMClient,
  type TokenUsage,
} from "../src/index.js"
import { emptyUsage, sumUsage } from "../src/usage.js"

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
    expect(onUsage).toHaveBeenCalledWith(
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        attempts: 1,
      } satisfies TokenUsage,
      { attemptNumber: 1, maxAttempts: 4, isLastAttempt: true },
    )
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

  it("reports OpenAI stream usage from the last chunk", async () => {
    const onUsage = vi.fn()
    const client = wrap(
      {
        async chatCompletionsCreate() {
          throw new Error("create should not be called")
        },
        async *chatCompletionsStream() {
          yield {
            choices: [{ delta: { content: '{"name":"John","age":25}' } }],
          }
          yield {
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 8 },
          }
        },
      },
      { mode: "JSON_SCHEMA", hooks: { onUsage } },
    )
    const snapshots: unknown[] = []
    for await (const snap of client.createPartial({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25" }],
    })) {
      snapshots.push(snap)
    }
    expect(snapshots.at(-1)).toEqual({ name: "John", age: 25 })
    expect(onUsage).toHaveBeenCalledWith(
      {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        attempts: 1,
      },
      { attemptNumber: 1, maxAttempts: 1, isLastAttempt: true },
    )
  })

  it("merges Anthropic message_start and message_delta usage on iterable", async () => {
    const onUsage = vi.fn()
    const client = wrap(
      {
        async chatCompletionsCreate() {
          throw new Error("create should not be called")
        },
        async *chatCompletionsStream() {
          yield {
            type: "message_start",
            message: { usage: { input_tokens: 15, output_tokens: 0 } },
          }
          yield {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json:
                '{"items":[{"name":"John","age":25},{"name":"Jane","age":30}]}',
            },
          }
          yield {
            type: "message_delta",
            usage: { output_tokens: 9 },
          }
        },
      },
      { mode: "ANTHROPIC_TOOLS", hooks: { onUsage } },
    )
    const items: unknown[] = []
    for await (const item of client.createIterable({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John and Jane" }],
    })) {
      items.push(item)
    }
    expect(items).toHaveLength(2)
    expect(onUsage).toHaveBeenCalledWith(
      {
        inputTokens: 15,
        outputTokens: 9,
        totalTokens: 24,
        attempts: 1,
      },
      { attemptNumber: 1, maxAttempts: 1, isLastAttempt: true },
    )
  })
})

describe("sumUsage", () => {
  it("adds two totals field by field", () => {
    const a = { inputTokens: 10, outputTokens: 4, totalTokens: 14, attempts: 1 }
    const b = { inputTokens: 5, outputTokens: 3, totalTokens: 8, attempts: 2 }
    expect(sumUsage(a, b)).toEqual({
      inputTokens: 15,
      outputTokens: 7,
      totalTokens: 22,
      attempts: 3,
    })
  })

  it("is identity when one side is empty", () => {
    const a = { inputTokens: 3, outputTokens: 1, totalTokens: 4, attempts: 1 }
    expect(sumUsage(a, emptyUsage())).toEqual(a)
  })
})
