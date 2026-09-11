import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  JsonParseError,
  SchemaValidationError,
  wrap,
  type LLMClient,
  type RequestKwargs,
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

function sequenceClient(
  responses: unknown[],
  capture: RequestKwargs[] = [],
): LLMClient {
  let index = 0
  return {
    async chatCompletionsCreate(kwargs) {
      capture.push(kwargs)
      const next = responses[index]
      index += 1
      if (next instanceof Error) {
        throw next
      }
      return next
    },
  }
}

describe("hooks", () => {
  it("calls onRequest, then onSuccess", async () => {
    const onRequest = vi.fn()
    const onParseError = vi.fn()
    const onSuccess = vi.fn()
    const client = wrap(sequenceClient([toolResponse({ name: "John", age: 25 })]), {
      hooks: { onRequest, onParseError, onSuccess },
    })

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })

    expect(user).toEqual({ name: "John", age: 25 })
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest.mock.calls[0]?.[0]).toMatchObject({ model: "test-model" })
    expect(onParseError).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledWith({ name: "John", age: 25 })
  })

  it("calls onParseError on validation failure, then onSuccess after reask", async () => {
    const onRequest = vi.fn()
    const onParseError = vi.fn()
    const onSuccess = vi.fn()
    const client = wrap(
      sequenceClient([
        toolResponse({ name: "John", age: "x" }),
        toolResponse({ name: "John", age: 25 }),
      ]),
      { hooks: { onRequest, onParseError, onSuccess } },
    )

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })

    expect(onRequest).toHaveBeenCalledTimes(2)
    expect(onParseError).toHaveBeenCalledTimes(1)
    expect(onParseError.mock.calls[0]?.[0]).toBeInstanceOf(SchemaValidationError)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })

  it("does not treat SDK errors as parse errors", async () => {
    const onRequest = vi.fn()
    const onParseError = vi.fn()
    const onSuccess = vi.fn()
    const boom = new Error("network down")
    const client = wrap(sequenceClient([boom]), {
      hooks: { onRequest, onParseError, onSuccess },
    })

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
      }),
    ).rejects.toBe(boom)

    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onParseError).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("lets create() hooks override wrap() hooks", async () => {
    const wrapSuccess = vi.fn()
    const createSuccess = vi.fn()
    const client = wrap(sequenceClient([toolResponse({ name: "John", age: 25 })]), {
      hooks: { onSuccess: wrapSuccess },
    })

    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
      hooks: { onSuccess: createSuccess },
    })

    expect(createSuccess).toHaveBeenCalledTimes(1)
    expect(wrapSuccess).not.toHaveBeenCalled()
  })

  it("calls onParseError for missing JSON", async () => {
    const onParseError = vi.fn()
    const client = wrap(
      sequenceClient([{ choices: [{ message: { content: "hello" } }] }]),
      { hooks: { onParseError } },
    )

    await client
      .create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
        maxRetries: 0,
      })
      .catch(() => undefined)

    expect(onParseError).toHaveBeenCalledTimes(1)
    expect(onParseError.mock.calls[0]?.[0]).toBeInstanceOf(JsonParseError)
  })
})
