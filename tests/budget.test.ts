import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  TokenBudgetExceeded,
  TokenUsageUnavailableError,
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

function sequenceClient(responses: unknown[]): {
  client: LLMClient
  calls: () => number
} {
  let index = 0
  return {
    client: {
      async chatCompletionsCreate() {
        const next = responses[index]
        index += 1
        return next
      },
    },
    calls: () => index,
  }
}

describe("tokenBudget", () => {
  it("stops before the reask once the budget is reached", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 60, completion_tokens: 40 }),
    ])
    const client = wrap(llm)

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25" }],
        tokenBudget: 100,
      }),
    ).rejects.toBeInstanceOf(TokenBudgetExceeded)

    // Exactly the boundary: 100 tokens used, budget 100, no second call.
    expect(calls()).toBe(1)
  })

  it("carries budget, usage, and attempts on the error", async () => {
    const { client: llm } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 70, completion_tokens: 30 }),
    ])
    const client = wrap(llm)

    const error = await client
      .create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        tokenBudget: 100,
      })
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(TokenBudgetExceeded)
    const budgetError = error as TokenBudgetExceeded
    expect(budgetError.budget).toBe(100)
    expect(budgetError.attempts).toBe(1)
    expect(budgetError.usage.totalTokens).toBe(100)
  })

  it("retries while the budget is not yet exhausted", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 20, completion_tokens: 10 }),
      toolResponse({ name: "John", age: 25 }, { prompt_tokens: 20, completion_tokens: 10 }),
    ])
    const client = wrap(llm)

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
      tokenBudget: 100,
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(calls()).toBe(2)
  })

  it("returns a valid response that crosses the budget", async () => {
    // 120 tokens used, budget 100, but the second attempt validated. The
    // guardrail blocks the next call, not the answer in hand.
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 30, completion_tokens: 30 }),
      toolResponse({ name: "John", age: 25 }, { prompt_tokens: 30, completion_tokens: 30 }),
    ])
    const client = wrap(llm)

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
      tokenBudget: 100,
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(calls()).toBe(2)
  })

  it("fails closed when a response omits usage", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: "x" }),
    ])
    const client = wrap(llm)

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        tokenBudget: 100,
      }),
    ).rejects.toBeInstanceOf(TokenUsageUnavailableError)
    expect(calls()).toBe(1)
  })

  it("reports usage through onUsage before throwing", async () => {
    const onUsage = vi.fn()
    const { client: llm } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 60, completion_tokens: 40 }),
    ])
    const client = wrap(llm, { hooks: { onUsage } })

    await client
      .create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        tokenBudget: 100,
      })
      .catch(() => undefined)

    expect(onUsage).toHaveBeenCalledWith(
      {
        inputTokens: 60,
        outputTokens: 40,
        totalTokens: 100,
        attempts: 1,
      } satisfies TokenUsage,
      { attemptNumber: 1, maxAttempts: 4, isLastAttempt: true },
    )
  })

  it("has no effect when no budget is set", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 9999, completion_tokens: 9999 }),
      toolResponse({ name: "John", age: 25 }, { prompt_tokens: 1, completion_tokens: 1 }),
    ])
    const client = wrap(llm)

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(calls()).toBe(2)
  })

  it("takes a default budget from wrap options", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 80, completion_tokens: 20 }),
    ])
    const client = wrap(llm, { tokenBudget: 100 })

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
      }),
    ).rejects.toBeInstanceOf(TokenBudgetExceeded)
    expect(calls()).toBe(1)
  })

  it("lets create() override the wrap default budget", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: "x" }, { prompt_tokens: 80, completion_tokens: 20 }),
      toolResponse({ name: "John", age: 25 }, { prompt_tokens: 1, completion_tokens: 1 }),
    ])
    const client = wrap(llm, { tokenBudget: 10 })

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
      tokenBudget: 500,
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(calls()).toBe(2)
  })

  it("rejects a non-integer budget before calling the provider", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: 25 }, { prompt_tokens: 1, completion_tokens: 1 }),
    ])
    const client = wrap(llm)

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        tokenBudget: 1.5,
      }),
    ).rejects.toThrow(/positive integer/)
    expect(calls()).toBe(0)
  })

  it("rejects a non-positive budget before calling the provider", async () => {
    const { client: llm, calls } = sequenceClient([
      toolResponse({ name: "John", age: 25 }, { prompt_tokens: 1, completion_tokens: 1 }),
    ])
    const client = wrap(llm)

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        tokenBudget: 0,
      }),
    ).rejects.toThrow(/greater than zero/)
    expect(calls()).toBe(0)
  })

  it("rejects a budget on createPartial()", async () => {
    const client = wrap(
      {
        async chatCompletionsCreate() {
          throw new Error("unused")
        },
        async *chatCompletionsStream() {
          yield { choices: [{ delta: { content: '{"name":"John","age":25}' } }] }
        },
      },
      { mode: "JSON_SCHEMA" },
    )

    const iterate = async () => {
      for await (const _snapshot of client.createPartial({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        tokenBudget: 100,
      })) {
        // no-op
      }
    }
    await expect(iterate()).rejects.toThrow(/not supported by createPartial/)
  })

  it("rejects a budget on createIterable()", async () => {
    const client = wrap(
      {
        async chatCompletionsCreate() {
          throw new Error("unused")
        },
        async *chatCompletionsStream() {
          yield { choices: [{ delta: { content: '[{"name":"John","age":25}]' } }] }
        },
      },
      { mode: "JSON_SCHEMA" },
    )

    const iterate = async () => {
      for await (const _item of client.createIterable({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        tokenBudget: 100,
      })) {
        // no-op
      }
    }
    await expect(iterate()).rejects.toThrow(/not supported by createIterable/)
  })
})
