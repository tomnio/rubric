import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { wrap, type LLMClient, type RequestKwargs } from "../src/index.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

function toolUseResponse(input: unknown, id = "toolu_1"): unknown {
  return {
    content: [
      {
        type: "tool_use",
        id,
        name: "extract",
        input,
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

describe("ANTHROPIC_TOOLS", () => {
  it("extracts a User from tool_use.input", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(sequenceClient([toolUseResponse({ name: "John", age: 25 })], capture), {
      mode: "ANTHROPIC_TOOLS",
    })
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [
        { role: "system", content: "Extract people." },
        { role: "user", content: "John is 25 years old" },
      ],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(capture[0]?.system).toBe("Extract people.")
    expect(capture[0]?.messages.map((message) => message.role)).toEqual(["user"])
    expect(capture[0]?.max_tokens).toBe(1024)
    expect(capture[0]?.tools).toEqual([
      expect.objectContaining({
        name: "extract",
        input_schema: expect.objectContaining({ type: "object" }),
      }),
    ])
    expect(capture[0]?.tool_choice).toEqual({
      type: "tool",
      name: "extract",
      disable_parallel_tool_use: true,
    })
  })

  it("reasks with tool_result on the user turn, not role=tool", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      sequenceClient(
        [
          toolUseResponse({ name: "John", age: "x" }, "toolu_1"),
          toolUseResponse({ name: "John", age: 25 }, "toolu_2"),
        ],
        capture,
      ),
      { mode: "ANTHROPIC_TOOLS" },
    )

    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })

    const second = capture[1]
    expect(second?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    const assistant = second?.messages[1]
    expect(assistant?.content).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "extract",
        input: { name: "John", age: "x" },
      },
    ])
    const followUp = second?.messages[2]
    expect(followUp?.content).toMatchObject([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        is_error: true,
      },
    ])
    expect(JSON.stringify(followUp?.content)).toMatch(/failed schema validation/)
    expect(second?.tool_choice).toEqual({
      type: "tool",
      name: "extract",
      disable_parallel_tool_use: true,
    })
  })

  it("wraps an Anthropic-shaped messages.create client", async () => {
    const create = vi.fn(async (_body: unknown) =>
      toolUseResponse({ name: "John", age: 25 }),
    )
    const anthropic = { messages: { create } }
    const client = wrap(anthropic)
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(create).toHaveBeenCalledTimes(1)
    const body = create.mock.calls[0]?.[0] as RequestKwargs
    expect(body.tools).toBeDefined()
    expect(body.max_tokens).toBe(1024)
  })

  it("streams from messages.create when stream is true", async () => {
    async function* events() {
      yield {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"name":"John","age":25}' },
      }
    }
    const create = vi.fn(async (body: unknown) => {
      const stream = (body as { stream?: boolean }).stream
      if (stream) {
        return events()
      }
      return toolUseResponse({ name: "John", age: 25 })
    })
    const client = wrap({ messages: { create } })
    const snapshots: unknown[] = []
    for await (const snap of client.createPartial({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })) {
      snapshots.push(snap)
    }
    expect(snapshots.at(-1)).toEqual({ name: "John", age: 25 })
    expect(create.mock.calls[0]?.[0]).toMatchObject({ stream: true })
  })
})
