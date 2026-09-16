import { describe, expect, it } from "vitest"
import { z } from "zod"
import { createDocument, type Chunker } from "../src/document/index.js"
import { mergeChunks, mergeInto, type ChunkValue } from "../src/document/merge.js"
import { type LLMClient } from "../src/index.js"

/**
 * Two chunks whose windows overlap, each holding one item list. Overlapping
 * windows are the case `dedupeBy` exists for: two readings of the same text.
 */
function pair(first: unknown, second: unknown): ChunkValue[] {
  return [
    { value: first, startIndex: 0, endIndex: 100 },
    { value: second, startIndex: 50, endIndex: 150 },
  ]
}

/** Two chunks with disjoint windows, so nothing is treated as an overlap. */
function disjoint(first: unknown, second: unknown): ChunkValue[] {
  return [
    { value: first, startIndex: 0, endIndex: 100 },
    { value: second, startIndex: 200, endIndex: 300 },
  ]
}

describe("dedupeBy", () => {
  it("merges two readings of one entity that share no field values", () => {
    // The headline case: the same line item, reworded across the boundary.
    // Whole-value dedupe cannot see they are one item; the key can.
    const merged = mergeChunks(
      pair(
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A1", price: 5 }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([{ sku: "A1", desc: "Coffee", price: 5 }])
  })

  it("keeps the first value when both readings set the same field", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A1", desc: "Coffee, ground" }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([{ sku: "A1", desc: "Coffee" }])
  })

  it("fills a null field from the later reading", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ sku: "A1", price: null }] },
        { items: [{ sku: "A1", price: 5 }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([{ sku: "A1", price: 5 }])
  })

  it("does not merge two entities with different keys", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A2", desc: "Tea" }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([
      { sku: "A1", desc: "Coffee" },
      { sku: "A2", desc: "Tea" },
    ])
  })

  it("still respects overlap: the same key in disjoint windows stays two items", () => {
    // Two windows that share no text are two sightings, even under one key.
    const merged = mergeChunks(
      disjoint(
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A1", desc: "Coffee" }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([
      { sku: "A1", desc: "Coffee" },
      { sku: "A1", desc: "Coffee" },
    ])
  })

  it("keeps a within-chunk repeat even under a key", () => {
    const merged = mergeChunks(
      [
        {
          value: {
            items: [
              { sku: "A1", desc: "Coffee" },
              { sku: "A1", desc: "Coffee" },
            ],
          },
          startIndex: 0,
          endIndex: 100,
        },
      ],
      { dedupeBy: "sku" },
    )
    expect(merged.items).toHaveLength(2)
  })

  it("accepts several field names as a composite key", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ region: "EU", sku: "A1", desc: "Coffee" }] },
        { items: [{ region: "EU", sku: "A1", price: 5 }] },
      ),
      { dedupeBy: ["region", "sku"] },
    )
    expect(merged.items).toEqual([
      { region: "EU", sku: "A1", desc: "Coffee", price: 5 },
    ])
  })

  it("keeps items apart when one component of a composite key differs", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ region: "EU", sku: "A1", desc: "Coffee" }] },
        { items: [{ region: "US", sku: "A1", desc: "Coffee" }] },
      ),
      { dedupeBy: ["region", "sku"] },
    )
    expect(merged.items).toHaveLength(2)
  })

  it("falls back to whole-value equality for an item missing the key field", () => {
    // Safe direction: an unidentifiable item dedupes structurally, so two
    // *different* unkeyed items both survive rather than being folded together
    // just because neither has a `sku`.
    const merged = mergeChunks(
      pair(
        { items: [{ desc: "Coffee" }] },
        { items: [{ desc: "Tea" }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([{ desc: "Coffee" }, { desc: "Tea" }])
  })

  it("still collapses two structurally equal unkeyed items", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ desc: "Coffee" }] },
        { items: [{ desc: "Coffee" }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([{ desc: "Coffee" }])
  })

  it("treats a null key field as missing", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ sku: null, desc: "Coffee" }] },
        { items: [{ sku: null, desc: "Tea" }] },
      ),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([
      { sku: null, desc: "Coffee" },
      { sku: null, desc: "Tea" },
    ])
  })

  it("does not merge a scalar item into an object that shares nothing", () => {
    // A non-object item has no key field, so it dedupes structurally.
    const merged = mergeChunks(
      pair({ items: ["Coffee"] }, { items: [{ sku: "Coffee" }] }),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toHaveLength(2)
  })

  it("does not let an entity key collide with a structural key", () => {
    // `entity:` is its own namespace: a plain item equal to the key's payload
    // must not be treated as the same thing.
    const merged = mergeChunks(
      pair({ items: [{ sku: "A1" }] }, { items: ['entity:["string:2:A1"]'] }),
      { dedupeBy: "sku" },
    )
    expect(merged.items).toHaveLength(2)
  })

  it("is off by default", () => {
    // Without the option, two reworded readings stay two items — the old
    // behaviour, so the option is purely additive.
    const merged = mergeChunks(
      pair(
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A1", price: 5 }] },
      ),
    )
    expect(merged.items).toHaveLength(2)
  })

  it("has no effect under dedupe: none", () => {
    const merged = mergeChunks(
      pair(
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A1", price: 5 }] },
      ),
      { dedupe: "none", dedupeBy: "sku" },
    )
    expect(merged.items).toHaveLength(2)
  })

  it("folds fields across three overlapping readings of one entity", () => {
    const merged = mergeChunks(
      [
        { value: { items: [{ sku: "A1", a: 1 }] }, startIndex: 0, endIndex: 100 },
        { value: { items: [{ sku: "A1", b: 2 }] }, startIndex: 50, endIndex: 150 },
        { value: { items: [{ sku: "A1", c: 3 }] }, startIndex: 100, endIndex: 200 },
      ],
      { dedupeBy: "sku" },
    )
    expect(merged.items).toEqual([{ sku: "A1", a: 1, b: 2, c: 3 }])
  })

  it("does not mutate the chunk values it was given", () => {
    const first = { items: [{ sku: "A1", desc: "Coffee" }] }
    const second = { items: [{ sku: "A1", price: 5 }] }
    const chunks = pair(first, second)
    mergeChunks(chunks, { dedupeBy: "sku" })
    // The fold must copy, not write through to the caller's objects.
    expect(first.items[0]).toEqual({ sku: "A1", desc: "Coffee" })
    expect(second.items[0]).toEqual({ sku: "A1", price: 5 })
  })
})

describe("createDocument dedupeBy", () => {
  const Line = z.object({
    sku: z.string(),
    desc: z.string().optional(),
    price: z.number().optional(),
  })
  const Invoice = z.object({ items: z.array(Line) })

  function fixedChunker(size: number): Chunker {
    return async (document) => {
      const result = []
      for (let start = 0; start < document.length; start += size) {
        const end = Math.min(document.length, start + size)
        result.push({ text: document.slice(start, end), startIndex: start, endIndex: end })
      }
      return result
    }
  }

  function toolResponse(payload: unknown): unknown {
    return {
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "extract", arguments: JSON.stringify(payload) },
              },
            ],
          },
        },
      ],
    }
  }

  function sequenceClient(payloads: unknown[]): LLMClient {
    let index = 0
    return {
      async chatCompletionsCreate() {
        const next = payloads[Math.min(index, payloads.length - 1)]
        index += 1
        return toolResponse(next)
      },
    }
  }

  function run(client: LLMClient, dedupeBy?: string) {
    return createDocument(client, {
      model: "test-model",
      document: "A".repeat(20),
      instruction: "Extract.",
      schema: Invoice,
      chunkSize: 10,
      overlap: 5,
      chunker: fixedChunker(10),
      ...(dedupeBy !== undefined ? { dedupeBy } : {}),
    })
  }

  it("merges two readings of one line item across overlapping chunks", async () => {
    const result = await run(
      sequenceClient([
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A1", price: 5 }] },
      ]),
      "sku",
    )
    expect(result.data.items).toEqual([{ sku: "A1", desc: "Coffee", price: 5 }])
  })

  it("keeps the two items apart without the option", async () => {
    const result = await run(
      sequenceClient([
        { items: [{ sku: "A1", desc: "Coffee" }] },
        { items: [{ sku: "A1", price: 5 }] },
      ]),
    )
    expect(result.data.items).toHaveLength(2)
  })
})

describe("dedupeBy on a root array", () => {
  const Item = z.array(z.object({ sku: z.string(), desc: z.string().optional(), price: z.number().optional() }))

  it("merges two readings of one entity", () => {
    const data = mergeInto(
      Item,
      pair([{ sku: "A1", desc: "Coffee" }], [{ sku: "A1", price: 5 }]),
      [],
      { dedupeBy: "sku" },
    )
    expect(data).toEqual([{ sku: "A1", desc: "Coffee", price: 5 }])
  })

  it("keeps distinct entities apart", () => {
    const data = mergeInto(
      Item,
      pair([{ sku: "A1" }], [{ sku: "A2" }]),
      [],
      { dedupeBy: "sku" },
    )
    expect(data).toEqual([{ sku: "A1" }, { sku: "A2" }])
  })

  it("still validates the merged result against the schema", () => {
    // Unioning fields cannot invent a required one that no reading had.
    const Required = z.array(z.object({ sku: z.string(), desc: z.string() }))
    expect(() =>
      mergeInto(Required, pair([{ sku: "A1" }], [{ sku: "A1" }]), [], {
        dedupeBy: "sku",
      }),
    ).toThrow()
  })
})
