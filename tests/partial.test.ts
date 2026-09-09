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

describe("createPartial", () => {
  it("yields growing snapshots from JSON_SCHEMA content deltas", async () => {
    const client = wrap(
      streamClient([
        contentDelta('{"name": "Jo'),
        contentDelta('hn", "age": 25}'),
      ]),
      { mode: "JSON_SCHEMA" },
    )

    const snapshots = await collect(
      client.createPartial({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
      }),
    )

    expect(snapshots[0]).toMatchObject({ name: "Jo" })
    expect(snapshots.at(-1)).toEqual({ name: "John", age: 25 })
  })

  it("yields growing snapshots from TOOLS argument deltas", async () => {
    const client = wrap(
      streamClient([
        toolArgsDelta('{"name":"John"'),
        toolArgsDelta(',"age":25}'),
      ]),
    )

    const snapshots = await collect(
      client.createPartial({
        model: "test-model",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
      }),
    )

    expect(snapshots.some((snap) => snap.name === "John" && snap.age === undefined)).toBe(
      true,
    )
    expect(snapshots.at(-1)).toEqual({ name: "John", age: 25 })
  })

  it("throws when the client cannot stream", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        return {}
      },
    })
    const iterable = client.createPartial({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    await expect(collect(iterable)).rejects.toThrow(/chatCompletionsStream/)
  })

  it("throws for ANTHROPIC_TOOLS", async () => {
    const client = wrap(streamClient([contentDelta("{}")]), {
      mode: "ANTHROPIC_TOOLS",
    })
    const iterable = client.createPartial({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    await expect(collect(iterable)).rejects.toThrow(/ANTHROPIC_TOOLS/)
  })

  it("throws JsonParseError when the stream never becomes JSON", async () => {
    const client = wrap(streamClient([contentDelta("hello")]), {
      mode: "JSON_SCHEMA",
    })
    const iterable = client.createPartial({
      model: "test-model",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    await expect(collect(iterable)).rejects.toBeInstanceOf(JsonParseError)
  })
})
