import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  wrap,
  type LLMClient,
  type RequestKwargs,
} from "../src/index.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

function contentResponse(content: string): unknown {
  return {
    choices: [{ message: { role: "assistant", content } }],
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

describe("JSON_SCHEMA mode", () => {
  it("extracts a User from message content", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [contentResponse(JSON.stringify({ name: "John", age: 25 }))],
        capture,
      ),
      { mode: "JSON_SCHEMA" },
    )

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(capture[0]?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "extract",
        strict: true,
        schema: { type: "object" },
      },
    })
  })

  it("reasks with a user error message", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [
          contentResponse(JSON.stringify({ name: "John", age: "x" })),
          contentResponse(JSON.stringify({ name: "John", age: 25 })),
        ],
        capture,
      ),
      { mode: "JSON_SCHEMA" },
    )

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(capture[1]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    expect(capture[1]?.messages.at(-1)?.content).toMatch(/failed schema validation/)
  })
})

describe("MD_JSON mode", () => {
  it("reads JSON from a markdown fence", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [
          contentResponse(
            'Sure:\n```json\n{"name":"John","age":25}\n```\n',
          ),
        ],
        capture,
      ),
      { mode: "MD_JSON" },
    )

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(capture[0]?.messages[0]?.role).toBe("system")
    expect(capture[0]?.messages[0]?.content).toMatch(/markdown fence/)
  })

  it("reads raw JSON when there is no fence", async () => {
    const client = wrap(
      sequenceClient([contentResponse('{"name":"John","age":25}')]),
      { mode: "MD_JSON" },
    )
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
  })

  it("ignores surrounding prose when a fence is present", async () => {
    const client = wrap(
      sequenceClient([
        contentResponse('Here you go:\n```json\n{"name":"John","age":25}\n```\nThanks.'),
      ]),
      { mode: "MD_JSON" },
    )
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
  })
})
