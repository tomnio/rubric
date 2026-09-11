import { describe, expect, it } from "vitest"
import { z } from "zod"
import { wrap, type LLMClient, type RequestKwargs } from "../src/index.js"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})
const Users = z.array(User)
const people = [
  { name: "John", age: 25 },
  { name: "Jane", age: 30 },
]

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

function contentResponse(content: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: typeof content === "string" ? content : JSON.stringify(content),
        },
      },
    ],
  }
}

function fakeClient(response: unknown, capture: RequestKwargs[] = []): LLMClient {
  return {
    async chatCompletionsCreate(kwargs) {
      capture.push(kwargs)
      return response
    },
  }
}

describe("array extract", () => {
  it("TOOLS: extracts User[] from a wrapped { items } payload", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(fakeClient(toolResponse({ items: people }), capture))
    const users = await client.create({
      model: "test-model",
      schema: Users,
      messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
    })
    expect(users).toEqual(people)
    const tools = capture[0]?.tools as Array<{ function: { parameters: { type: string } } }>
    expect(tools[0]?.function.parameters.type).toBe("object")
  })

  it("JSON_SCHEMA: extracts User[] from { items }", async () => {
    const client = wrap(fakeClient(contentResponse({ items: people })), {
      mode: "JSON_SCHEMA",
    })
    const users = await client.create({
      model: "test-model",
      schema: Users,
      messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
    })
    expect(users).toEqual(people)
  })

  it("MD_JSON: extracts User[] from a raw JSON array", async () => {
    const client = wrap(fakeClient(contentResponse(people)), { mode: "MD_JSON" })
    const users = await client.create({
      model: "test-model",
      schema: Users,
      messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
    })
    expect(users).toEqual(people)
  })

  it("extracts an object that contains an array field", async () => {
    const Team = z.object({
      members: z.array(User),
    })
    const client = wrap(
      fakeClient(toolResponse({ members: people })),
    )
    const team = await client.create({
      model: "test-model",
      schema: Team,
      messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
    })
    expect(team.members).toEqual(people)
  })
})
