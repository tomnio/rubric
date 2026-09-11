import { describe, expect, it } from "vitest"
import { z } from "zod"
import { JsonParseError, wrap, type LLMClient } from "../src/index.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

function contentDelta(text: string): unknown {
  return { choices: [{ delta: { content: text } }] }
}

function toolArgsDelta(text: string): unknown {
  return {
    choices: [
      {
        delta: {
          tool_calls: [{ function: { arguments: text } }],
        },
      },
    ],
  }
}

function streamClient(chunks: unknown[]): LLMClient {
  return {
    async chatCompletionsCreate() {
      throw new Error("create should not be called")
    },
    async *chatCompletionsStream() {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iterable) {
    items.push(item)
  }
  return items
}

describe("createIterable", () => {
  it("yields each complete User before the next one finishes", async () => {
    const client = wrap(
      streamClient([
        contentDelta('[{"name":"John","age":25},'),
        contentDelta('{"name":"Ja'),
        contentDelta('ne","age":30}]'),
      ]),
      { mode: "JSON_SCHEMA" },
    )

    const seen: unknown[][] = []
    const items: unknown[] = []
    for await (const item of client.createIterable({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
    })) {
      items.push(item)
      seen.push([...items])
    }

    expect(seen[0]).toEqual([{ name: "John", age: 25 }])
    expect(items).toEqual([
      { name: "John", age: 25 },
      { name: "Jane", age: 30 },
    ])
  })

  it("does not yield an incomplete trailing object", async () => {
    const client = wrap(
      streamClient([
        contentDelta('[{"name":"John","age":25},{"name":"Jane"}]'),
      ]),
      { mode: "JSON_SCHEMA" },
    )

    const items = await collect(
      client.createIterable({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John and Jane" }],
      }),
    )
    expect(items).toEqual([{ name: "John", age: 25 }])
  })

  it("works with TOOLS argument deltas", async () => {
    const client = wrap(
      streamClient([
        toolArgsDelta('{"items":[{"name":"John","age":25},{"name":"Jane","age":30}]}'),
      ]),
    )
    const items = await collect(
      client.createIterable({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
      }),
    )
    expect(items).toEqual([
      { name: "John", age: 25 },
      { name: "Jane", age: 30 },
    ])
  })

  it("yields complete items from Anthropic input_json_delta chunks", async () => {
    const client = wrap(
      streamClient([
        {
          type: "content_block_delta",
          delta: {
            type: "input_json_delta",
            partial_json: '{"items":[{"name":"John","age":25},',
          },
        },
        {
          type: "content_block_delta",
          delta: {
            type: "input_json_delta",
            partial_json: '{"name":"Jane","age":30}]}',
          },
        },
      ]),
      { mode: "ANTHROPIC_TOOLS" },
    )

    const items = await collect(
      client.createIterable({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
      }),
    )
    expect(items).toEqual([
      { name: "John", age: 25 },
      { name: "Jane", age: 30 },
    ])
  })

  it("throws when no complete item arrives", async () => {
    const client = wrap(streamClient([contentDelta('[{"name":"Jo')]), {
      mode: "JSON_SCHEMA",
    })
    await expect(
      collect(
        client.createIterable({
          model: "test-model",
          schema: User,
          messages: [{ role: "user", content: "John" }],
        }),
      ),
    ).rejects.toBeInstanceOf(JsonParseError)
  })
})
