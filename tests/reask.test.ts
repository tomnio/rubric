import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  SchemaValidationError,
  wrap,
  type LLMClient,
  type Message,
  type RequestKwargs,
} from "../src/index.ts"
import { EXTRACT_TOOL_NAME, toolsHandler } from "../src/modes/tools.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
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
                arguments:
                  typeof payload === "string" ? payload : JSON.stringify(payload),
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

describe("reask", () => {
  it("retries after invalid JSON and succeeds on the next tool call", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [
          toolResponse({ name: "John", age: "twenty-five" }, "call_1"),
          toolResponse({ name: "John", age: 25 }, "call_2"),
        ],
        capture,
      ),
    )

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(capture).toHaveLength(2)

    const second = capture[1]
    const roles = second?.messages.map((message) => message.role)
    expect(roles).toEqual(["user", "assistant", "tool"])
    const tool = second?.messages.find((message) => message.role === "tool")
    expect(tool?.tool_call_id).toBe("call_1")
    expect(tool?.content).toMatch(/failed schema validation/)
    expect(tool?.content).toMatch(/age/)
    expect(second?.tool_choice).toEqual({
      type: "function",
      function: { name: EXTRACT_TOOL_NAME },
    })
  })

  it("succeeds after two failures when maxRetries is 2", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [
          toolResponse({ name: "John" }, "call_1"),
          toolResponse("not-json", "call_2"),
          toolResponse({ name: "John", age: 25 }, "call_3"),
        ],
        capture,
      ),
    )

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
      maxRetries: 2,
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(capture).toHaveLength(3)
  })

  it("does not retry SDK errors", async () => {
    const capture: RequestKwargs[] = []
    const boom = new Error("network down")
    const client = wrap(sequenceClient([boom], capture))

    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
        maxRetries: 3,
      }),
    ).rejects.toBe(boom)
    expect(capture).toHaveLength(1)
  })

  it("does not mutate the original messages when reasking", () => {
    const messages: Message[] = [{ role: "user", content: "John is 25 years old" }]
    const prepared = toolsHandler.prepareRequest(User, {
      model: "test-model",
      messages,
    })
    const next = toolsHandler.handleReask(
      prepared,
      toolResponse({ name: "John", age: "x" }, "call_1"),
      new SchemaValidationError("invalid", []),
    )
    expect(messages).toHaveLength(1)
    expect(next.messages).not.toBe(messages)
    expect(next.messages.length).toBeGreaterThan(messages.length)
  })
})
