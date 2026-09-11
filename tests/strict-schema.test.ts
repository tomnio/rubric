import { describe, expect, it } from "vitest"
import { z } from "zod"
import { wrap, type LLMClient } from "../src/index.js"
import { jsonSchemaHandler } from "../src/modes/json-schema.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

function contentClient(payload: unknown): LLMClient {
  return {
    async chatCompletionsCreate() {
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify(payload),
            },
          },
        ],
      }
    },
  }
}

describe("JSON_SCHEMA strict checks", () => {
  it("rejects .optional() fields locally", () => {
    const OptionalUser = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    })
    expect(() =>
      jsonSchemaHandler.prepareRequest(OptionalUser, {
        model: "test-model",
        messages: [],
      }),
    ).toThrow(/optional properties \(nickname\)/)
  })

  it("allows .nullable() fields", async () => {
    const NullableUser = z.object({
      name: z.string(),
      nickname: z.string().nullable(),
    })
    const client = wrap(contentClient({ name: "John", nickname: null }), {
      mode: "JSON_SCHEMA",
    })
    const user = await client.create({
      model: "test-model",
      schema: NullableUser,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", nickname: null })
  })

  it("rejects z.record locally", () => {
    const Bag = z.object({
      labels: z.record(z.string()),
    })
    expect(() =>
      jsonSchemaHandler.prepareRequest(Bag, {
        model: "test-model",
        messages: [],
      }),
    ).toThrow(/record or open object/)
  })

  it("still allows .optional() in TOOLS", async () => {
    const OptionalUser = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    })
    const client = wrap({
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
                      arguments: JSON.stringify({ name: "John" }),
                    },
                  },
                ],
              },
            },
          ],
        }
      },
    })
    const user = await client.create({
      model: "test-model",
      schema: OptionalUser,
      messages: [{ role: "user", content: "John" }],
    })
    expect(user).toEqual({ name: "John" })
  })
})
