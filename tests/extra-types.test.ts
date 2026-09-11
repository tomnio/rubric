import { describe, expect, it } from "vitest"
import { z } from "zod"
import { wrap, type LLMClient, type RequestKwargs } from "../src/index.js"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.js"

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

function fakeClient(response: unknown, capture: RequestKwargs[] = []): LLMClient {
  return {
    async chatCompletionsCreate(kwargs) {
      capture.push(kwargs)
      return response
    },
  }
}

const Pet = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dog"), bark: z.boolean() }),
  z.object({ kind: z.literal("cat"), lives: z.number() }),
])

describe("extra Zod types", () => {
  it("extracts a discriminated union via TOOLS", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(fakeClient(toolResponse({ kind: "cat", lives: 9 }), capture))
    const pet = await client.create({
      model: "test-model",
      schema: Pet,
      messages: [{ role: "user", content: "a cat with 9 lives" }],
    })
    expect(pet).toEqual({ kind: "cat", lives: 9 })
    const tools = capture[0]?.tools as Array<{
      function: { parameters: { anyOf?: unknown[] } }
    }>
    expect(tools[0]?.function.parameters.anyOf).toHaveLength(2)
  })

  it("extracts ISO dates as Date via JSON_SCHEMA", async () => {
    const Event = z.object({
      title: z.string(),
      at: z.date(),
    })
    const client = wrap(
      fakeClient(contentResponse({ title: "Standup", at: "2026-09-11T01:00:00.000Z" })),
      { mode: "JSON_SCHEMA" },
    )
    const event = await client.create({
      model: "test-model",
      schema: Event,
      messages: [{ role: "user", content: "Standup at 2026-09-11T01:00:00.000Z" }],
    })
    expect(event.title).toBe("Standup")
    expect(event.at).toBeInstanceOf(Date)
    expect(event.at.toISOString()).toBe("2026-09-11T01:00:00.000Z")
  })

  it("extracts a string record", async () => {
    const Bag = z.object({
      labels: z.record(z.string()),
    })
    const client = wrap(fakeClient(toolResponse({ labels: { env: "prod", team: "core" } })))
    const bag = await client.create({
      model: "test-model",
      schema: Bag,
      messages: [{ role: "user", content: "env prod, team core" }],
    })
    expect(bag).toEqual({ labels: { env: "prod", team: "core" } })
  })
})
