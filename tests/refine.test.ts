import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  formatError,
  SchemaValidationError,
  wrap,
  type LLMClient,
  type RequestKwargs,
} from "../src/index.ts"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.ts"

const Adult = z.object({
  name: z.string(),
  age: z.number().int().refine((value) => value >= 18, {
    message: "must be 18 or older",
  }),
})

function toolResponse(payload: unknown, id = "call_1"): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
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
      return responses[index++]
    },
  }
}

describe("refine reask", () => {
  it("puts the refine message into the next tool error", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [
          toolResponse({ name: "John", age: 10 }, "call_1"),
          toolResponse({ name: "John", age: 18 }, "call_2"),
        ],
        capture,
      ),
    )

    const user = await client.create({
      model: "test-model",
      schema: Adult,
      messages: [{ role: "user", content: "John is 10" }],
    })
    expect(user).toEqual({ name: "John", age: 18 })
    expect(capture).toHaveLength(2)
    const tool = capture[1]?.messages.find((message) => message.role === "tool")
    expect(tool?.content).toMatch(/must be 18 or older/)
    expect(tool?.content).toMatch(/age/)
  })

  it("includes superRefine issues at the given path", async () => {
    const Pair = z
      .object({
        min: z.number(),
        max: z.number(),
      })
      .superRefine((value, ctx) => {
        if (value.max < value.min) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["max"],
            message: "max must be >= min",
          })
        }
      })

    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [
          toolResponse({ min: 10, max: 3 }, "call_1"),
          toolResponse({ min: 3, max: 10 }, "call_2"),
        ],
        capture,
      ),
    )

    const pair = await client.create({
      model: "test-model",
      schema: Pair,
      messages: [{ role: "user", content: "min 10 max 3" }],
    })
    expect(pair).toEqual({ min: 3, max: 10 })
    expect(capture[1]?.messages.at(-1)?.content).toMatch(/max must be >= min/)
  })

  it("formatError prints custom issue path and message", () => {
    const parsed = Adult.safeParse({ name: "John", age: 10 })
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const text = formatError(
      new SchemaValidationError("invalid", parsed.error.issues),
    )
    expect(text).toMatch(/age: must be 18 or older/)
  })
})
