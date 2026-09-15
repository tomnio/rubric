import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  JsonParseError,
  RetryExhaustedError,
  wrap,
  type LLMClient,
} from "../src/index.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

/** Always fails schema validation, so every attempt is a real provider call. */
function failingClient(): { client: LLMClient; calls: () => number } {
  let calls = 0
  return {
    client: {
      async chatCompletionsCreate() {
        calls += 1
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
                      // Valid JSON, wrong shape: a retryable failure.
                      arguments: JSON.stringify({ name: 1 }),
                    },
                  },
                ],
              },
            },
          ],
        }
      },
    },
    calls: () => calls,
  }
}

function validClient(): LLMClient {
  return {
    async chatCompletionsCreate() {
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
                    arguments: JSON.stringify({ name: "John", age: 25 }),
                  },
                },
              ],
            },
          },
        ],
      }
    },
  }
}

const messages = [{ role: "user" as const, content: "John is 25" }]

describe("maxRetries validation", () => {
  it("rejects a negative maxRetries before any call", async () => {
    const { client, calls } = failingClient()
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: -1 }),
    ).rejects.toBeInstanceOf(RangeError)
    expect(calls()).toBe(0)
  })

  it("rejects NaN maxRetries before any call", async () => {
    const { client, calls } = failingClient()
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: NaN }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(calls()).toBe(0)
  })

  it("rejects a fractional maxRetries instead of rounding it up", async () => {
    // 0.5 used to mean two attempts — more spend than the caller wrote.
    const { client, calls } = failingClient()
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: 0.5 }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(calls()).toBe(0)
  })

  it("rejects Infinity", async () => {
    const { client, calls } = failingClient()
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: Infinity }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(calls()).toBe(0)
  })

  it("names maxRetries in the message", async () => {
    const { client } = failingClient()
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: -1 }),
    ).rejects.toThrow(/maxRetries/)
  })

  it("accepts 0 as one attempt", async () => {
    const { client, calls } = failingClient()
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(calls()).toBe(1)
  })

  it("accepts a positive integer and makes maxRetries + 1 calls", async () => {
    const { client, calls } = failingClient()
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: 3 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(calls()).toBe(4)
  })

  it("validates the wrap-level default too", async () => {
    const { client, calls } = failingClient()
    await expect(
      wrap(client, { maxRetries: -1 }).create({ model: "m", schema: User, messages }),
    ).rejects.toBeInstanceOf(RangeError)
    expect(calls()).toBe(0)
  })

  it("lets a per-call maxRetries override a valid wrap-level default", async () => {
    const { client, calls } = failingClient()
    await expect(
      wrap(client, { maxRetries: 3 }).create({
        model: "m",
        schema: User,
        messages,
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(calls()).toBe(1)
  })

  it("still succeeds when the first response validates", async () => {
    const user = await wrap(validClient()).create({
      model: "m",
      schema: User,
      messages,
      maxRetries: 2,
    })
    expect(user).toEqual({ name: "John", age: 25 })
  })
})

describe("RetryExhaustedError.lastError", () => {
  it("carries the last retryable failure", async () => {
    const { client } = failingClient()
    try {
      await wrap(client).create({ model: "m", schema: User, messages, maxRetries: 0 })
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError)
      const exhausted = error as RetryExhaustedError
      expect(exhausted.attempts).toBe(1)
      expect(exhausted.lastError).toBeDefined()
      expect(exhausted.lastError?.name).toBe("SchemaValidationError")
    }
  })

  it("is undefined when the error is built with no attempt behind it", () => {
    // The constructor is public, so a caller may describe a call that never
    // reached the provider. The type must not promise a value that is absent.
    const error = new RetryExhaustedError("gave up", 0)
    expect(error.lastError).toBeUndefined()
  })

  it("still stores a lastError that was passed", () => {
    const last = new JsonParseError("not json", null)
    const error = new RetryExhaustedError("gave up", 4, last)
    expect(error.attempts).toBe(4)
    expect(error.lastError).toBe(last)
  })
})
