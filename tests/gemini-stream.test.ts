import { describe, expect, it } from "vitest"
import { z } from "zod"
import { JsonParseError, wrap } from "../src/index.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

/** A chunk shaped like the SDK's GenerateContentResponse (candidates form). */
function candidateDelta(text: string): unknown {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  }
}

/** A chunk using the `text` getter shape the SDK also exposes. */
function textDelta(text: string): unknown {
  return { text }
}

/**
 * The real `@google/genai` SDK resolves `generateContentStream` to an async
 * iterable, so this fake returns a promise to mirror that contract.
 */
function streamClient(chunks: unknown[]) {
  return {
    models: {
      async generateContent() {
        throw new Error("create should not be called")
      },
      generateContentStream() {
        return Promise.resolve(
          (async function* () {
            for (const chunk of chunks) {
              yield chunk
            }
          })(),
        )
      },
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

describe("Gemini streaming", () => {
  it("yields growing snapshots from candidate part deltas", async () => {
    const client = wrap(
      streamClient([
        candidateDelta('{"name": "Jo'),
        candidateDelta('hn", "age": 25}'),
      ]),
    )

    const snapshots = await collect(
      client.createPartial({
        model: "gemini-2.5-flash",
        schema: User,
        messages: [{ role: "user", content: "John is 25 years old" }],
      }),
    )

    expect(snapshots[0]).toMatchObject({ name: "Jo" })
    expect(snapshots.at(-1)).toEqual({ name: "John", age: 25 })
  })

  it("yields snapshots from `text` chunks", async () => {
    const client = wrap(
      streamClient([textDelta('{"name": "Ja'), textDelta('ne", "age": 30}')]),
    )

    const snapshots = await collect(
      client.createPartial({
        model: "gemini-2.5-flash",
        schema: User,
        messages: [{ role: "user", content: "Jane is 30" }],
      }),
    )

    expect(snapshots.at(-1)).toEqual({ name: "Jane", age: 30 })
  })

  it("yields each complete item before the next one finishes", async () => {
    const client = wrap(
      streamClient([
        candidateDelta('[{"name":"John","age":25},'),
        candidateDelta('{"name":"Ja'),
        candidateDelta('ne","age":30}]'),
      ]),
    )

    const items = await collect(
      client.createIterable({
        model: "gemini-2.5-flash",
        schema: User,
        messages: [{ role: "user", content: "John is 25 and Jane is 30" }],
      }),
    )

    expect(items).toEqual([
      { name: "John", age: 25 },
      { name: "Jane", age: 30 },
    ])
  })

  it("reports usage metadata from stream chunks", async () => {
    let usage: unknown
    const client = wrap(streamClient([candidateDelta('{"name":"John","age":25}')]), {
      hooks: { onUsage: (value) => (usage = value) },
    })

    await collect(
      client.createPartial({
        model: "gemini-2.5-flash",
        schema: User,
        messages: [{ role: "user", content: "John is 25" }],
      }),
    )

    expect(usage).toMatchObject({ attempts: 1 })
  })

  it("throws JsonParseError when the stream never becomes JSON", async () => {
    const client = wrap(streamClient([candidateDelta("hello")]))
    await expect(
      collect(
        client.createPartial({
          model: "gemini-2.5-flash",
          schema: User,
          messages: [{ role: "user", content: "John is 25" }],
        }),
      ),
    ).rejects.toBeInstanceOf(JsonParseError)
  })

  it("throws when the client cannot stream", async () => {
    const client = wrap({
      models: {
        async generateContent() {
          return { text: "{}" }
        },
      },
    })
    await expect(
      collect(
        client.createPartial({
          model: "gemini-2.5-flash",
          schema: User,
          messages: [{ role: "user", content: "John is 25" }],
        }),
      ),
    ).rejects.toThrow(/generateContentStream/)
  })
})
