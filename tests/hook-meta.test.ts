import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  SchemaValidationError,
  wrap,
  type AttemptMeta,
  type LLMClient,
} from "../src/index.js"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.js"

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

function sequenceClient(responses: unknown[]): LLMClient {
  let index = 0
  return {
    async chatCompletionsCreate() {
      const next = responses[index]
      index += 1
      if (next instanceof Error) {
        throw next
      }
      return next
    },
  }
}

/** Second argument of every call a hook received. */
function metas(fn: ReturnType<typeof vi.fn>): AttemptMeta[] {
  return fn.mock.calls.map((call) => call[1] as AttemptMeta)
}

describe("hook attempt metadata", () => {
  it("passes attemptNumber and maxAttempts to onRequest", async () => {
    const onRequest = vi.fn()
    const client = wrap(
      sequenceClient([
        toolResponse({ name: "John", age: "x" }),
        toolResponse({ name: "John", age: 25 }),
      ]),
      { hooks: { onRequest } },
    )

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
      maxRetries: 1,
    })

    expect(metas(onRequest)).toEqual([
      { attemptNumber: 1, maxAttempts: 2, isLastAttempt: false },
      { attemptNumber: 2, maxAttempts: 2, isLastAttempt: true },
    ])
  })

  it("marks a mid-loop parse error as not the last attempt", async () => {
    const onParseError = vi.fn()
    const client = wrap(
      sequenceClient([
        toolResponse({ name: "John", age: "x" }),
        toolResponse({ name: "John", age: 25 }),
      ]),
      { hooks: { onParseError } },
    )

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
      maxRetries: 2,
    })

    expect(onParseError).toHaveBeenCalledTimes(1)
    expect(onParseError.mock.calls[0]?.[0]).toBeInstanceOf(SchemaValidationError)
    expect(metas(onParseError)).toEqual([
      { attemptNumber: 1, maxAttempts: 3, isLastAttempt: false },
    ])
  })

  it("marks the final parse error as the last attempt", async () => {
    const onParseError = vi.fn()
    const client = wrap(
      sequenceClient([toolResponse({ name: "John", age: "x" })]),
      { hooks: { onParseError } },
    )

    await client
      .create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        maxRetries: 0,
      })
      .catch(() => undefined)

    expect(metas(onParseError)).toEqual([
      { attemptNumber: 1, maxAttempts: 1, isLastAttempt: true },
    ])
  })

  it("reports isLastAttempt on success", async () => {
    const onSuccess = vi.fn()
    const client = wrap(sequenceClient([toolResponse({ name: "John", age: 25 })]), {
      hooks: { onSuccess },
    })

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
      maxRetries: 3,
    })

    expect(metas(onSuccess)).toEqual([
      { attemptNumber: 1, maxAttempts: 4, isLastAttempt: true },
    ])
  })

  it("routes an SDK error to onError, not onParseError", async () => {
    const onError = vi.fn()
    const onParseError = vi.fn()
    const boom = new Error("network down")
    const client = wrap(sequenceClient([boom]), {
      hooks: { onError, onParseError },
    })

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        maxRetries: 3,
      }),
    ).rejects.toBe(boom)

    expect(onParseError).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toBe(boom)
    // SDK errors are not retried, so the attempt that hit one is the last.
    expect(metas(onError)).toEqual([
      { attemptNumber: 1, maxAttempts: 4, isLastAttempt: true },
    ])
  })

  it("tells onParseError that a budget stop ended the loop", async () => {
    const onParseError = vi.fn()
    const onUsage = vi.fn()
    const client = wrap(
      sequenceClient([
        {
          usage: { prompt_tokens: 60, completion_tokens: 40 },
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
                      arguments: JSON.stringify({ name: "John", age: "x" }),
                    },
                  },
                ],
              },
            },
          ],
        },
      ]),
      { hooks: { onParseError, onUsage } },
    )

    await client
      .create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "x" }],
        maxRetries: 3,
        tokenBudget: 100,
      })
      .catch(() => undefined)

    // Attempts remained, but the budget made this the last attempt.
    expect(metas(onParseError)).toEqual([
      { attemptNumber: 1, maxAttempts: 4, isLastAttempt: true },
    ])
    expect(metas(onUsage).at(-1)).toEqual({
      attemptNumber: 1,
      maxAttempts: 4,
      isLastAttempt: true,
    })
  })

  it("ignores a throwing hook instead of failing the call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const onRequest = vi.fn(() => {
      throw new Error("handler bug")
    })
    const onSuccess = vi.fn()
    const client = wrap(sequenceClient([toolResponse({ name: "John", age: 25 })]), {
      hooks: { onRequest, onSuccess },
    })

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
    })

    expect(user).toEqual({ name: "John", age: 25 })
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      "rubric: onRequest hook threw and was ignored",
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it("gives streaming usage a single-attempt meta", async () => {
    const onUsage = vi.fn()
    const client = wrap(
      {
        async chatCompletionsCreate() {
          throw new Error("unused")
        },
        async *chatCompletionsStream() {
          yield {
            choices: [{ delta: { content: '{"name":"John","age":25}' } }],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          }
        },
      },
      { mode: "JSON_SCHEMA", hooks: { onUsage } },
    )

    for await (const _snapshot of client.createPartial({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "x" }],
    })) {
      // no-op
    }

    expect(metas(onUsage)).toEqual([
      { attemptNumber: 1, maxAttempts: 1, isLastAttempt: true },
    ])
  })
})
