import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  JsonParseError,
  SchemaValidationError,
  wrap,
  type LLMClient,
  type RequestKwargs,
} from "../src/index.ts"
import { EXTRACT_TOOL_NAME, toolsHandler } from "../src/modes/tools.ts"

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
                arguments: typeof payload === "string" ? payload : JSON.stringify(payload),
              },
            },
          ],
        },
      },
    ],
  }
}

function fakeClient(
  response: unknown,
  capture: { kwargs?: RequestKwargs } = {},
): LLMClient {
  return {
    async chatCompletionsCreate(kwargs) {
      capture.kwargs = kwargs
      return response
    },
  }
}

describe("TOOLS mode", () => {
  it("extracts a typed object from canned tool_calls", async () => {
    const client = wrap(fakeClient(toolResponse({ name: "John", age: 25 })))
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
  })

  it("attaches tools and tool_choice on the request", async () => {
    const capture: { kwargs?: RequestKwargs } = {}
    const client = wrap(fakeClient(toolResponse({ name: "John", age: 25 }), capture))
    await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })

    const tools = capture.kwargs?.tools as Array<{
      function: { name: string; parameters: unknown }
    }>
    expect(tools[0]?.function.name).toBe(EXTRACT_TOOL_NAME)
    expect(tools[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
    })
    expect(capture.kwargs?.tool_choice).toEqual({
      type: "function",
      function: { name: EXTRACT_TOOL_NAME },
    })
  })

  it("throws JsonParseError when tool_calls are missing", async () => {
    const client = wrap(fakeClient({ choices: [{ message: { content: "hello" } }] }))
    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
      }),
    ).rejects.toBeInstanceOf(JsonParseError)
  })

  it("throws SchemaValidationError when JSON does not match the schema", async () => {
    const client = wrap(fakeClient(toolResponse({ name: "John", age: "twenty-five" })))
    await expect(
      client.create({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
      }),
    ).rejects.toBeInstanceOf(SchemaValidationError)
  })

  it("does not mutate the original messages array", () => {
    const messages = [{ role: "user" as const, content: "John is 25 years old" }]
    const prepared = toolsHandler.prepareRequest(User, {
      model: "test-model",
      messages,
    })
    expect(prepared.messages).toBe(messages)
    expect(messages).toHaveLength(1)
  })
})
