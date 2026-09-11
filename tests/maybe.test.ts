import { describe, expect, it } from "vitest"
import { z } from "zod"
import { maybe, wrap, type LLMClient } from "../src/index.js"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})
const MaybeUser = maybe(User)

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

function contentResponse(payload: unknown): unknown {
  return {
    choices: [{ message: { role: "assistant", content: JSON.stringify(payload) } }],
  }
}

function fakeClient(response: unknown): LLMClient {
  return {
    async chatCompletionsCreate() {
      return response
    },
  }
}

describe("maybe", () => {
  it("returns the extracted object when present", async () => {
    const client = wrap(
      fakeClient(
        toolResponse({
          result: { name: "John", age: 25 },
          error: false,
          message: null,
        }),
      ),
    )
    const value = await client.create({
      model: "test-model",
      schema: MaybeUser,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(value).toEqual({
      result: { name: "John", age: 25 },
      error: false,
      message: null,
    })
  })

  it("returns error=true and result=null when nothing matches", async () => {
    const client = wrap(
      fakeClient(
        toolResponse({
          result: null,
          error: true,
          message: "No person mentioned in the text",
        }),
      ),
    )
    const value = await client.create({
      model: "test-model",
      schema: MaybeUser,
      messages: [{ role: "user", content: "It rained all afternoon." }],
    })
    expect(value.error).toBe(true)
    expect(value.result).toBeNull()
    expect(value.message).toMatch(/No person/)
  })

  it("works with JSON_SCHEMA mode", async () => {
    const client = wrap(
      fakeClient(
        contentResponse({
          result: { name: "John", age: 25 },
          error: false,
          message: null,
        }),
      ),
      { mode: "JSON_SCHEMA" },
    )
    const value = await client.create({
      model: "test-model",
      schema: MaybeUser,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(value.result).toEqual({ name: "John", age: 25 })
  })
})
