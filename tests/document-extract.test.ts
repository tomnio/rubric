import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createDocument,
  DocumentChunkError,
  DocumentMergeError,
  DocumentNoDataError,
  type Chunker,
  type DocumentChunk,
} from "../src/document/index.js"
import {
  wrap,
  type AttemptMeta,
  type LLMClient,
  type RequestKwargs,
} from "../src/index.js"

/** Split into fixed-width windows, so tests control chunk boundaries exactly. */
function fixedChunker(size: number, overlap = 0): Chunker {
  return async (document) => {
    const chunks: DocumentChunk[] = []
    for (let start = 0; start < document.length; start += size) {
      const end = Math.min(document.length, start + size)
      const startIndex = Math.max(0, start - overlap)
      const endIndex = Math.min(document.length, end + overlap)
      chunks.push({ text: document.slice(startIndex, endIndex), startIndex, endIndex })
    }
    return chunks
  }
}

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
                name: "extract",
                arguments:
                  typeof payload === "string" ? payload : JSON.stringify(payload),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

/**
 * Answer each chunk from a lookup keyed by a marker inside the chunk text.
 * Falls back to `fallback` for any chunk with no entry.
 */
function chunkAwareClient(
  answers: Array<unknown | Error>,
  capture: RequestKwargs[] = [],
): LLMClient {
  let index = 0
  return {
    async chatCompletionsCreate(kwargs) {
      capture.push(kwargs)
      const next = answers[index] ?? answers[answers.length - 1]
      index += 1
      if (next instanceof Error) {
        throw next
      }
      return toolResponse(next)
    },
  }
}

const DOC = "AAAA BBBB CCCC DDDD"

const Invoice = z.object({
  title: z.string(),
  items: z.array(z.object({ id: z.number() })),
})

/** Tolerant of a chunk that holds only part of the document. */
const ChunkInvoice = z.object({
  title: z.string().nullable().default(null),
  items: z.array(z.object({ id: z.number() })).default([]),
})

describe("createDocument", () => {
  it("merges per-chunk results and validates against the full schema", async () => {
    const client = chunkAwareClient([
      { title: "Invoice", items: [{ id: 1 }] },
      { title: null, items: [{ id: 2 }] },
    ])
    // DOC is 19 characters; size 10 splits it into two chunks.
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract the invoice.",
        schema: Invoice,
        chunkSchema: ChunkInvoice,
        chunkSize: 10,
        overlap: 0,
        chunker: fixedChunker(10),
      },
      { mode: "TOOLS" },
    )

    expect(result.data).toEqual({
      title: "Invoice",
      items: [{ id: 1 }, { id: 2 }],
    })
    expect(result.chunks.length).toBe(2)
    expect(result.usage.attempts).toBe(2)
    expect(result.usage.totalTokens).toBe(30)
  })

  it("reports provenance with absolute offsets into the document", async () => {
    const client = chunkAwareClient([{ title: "T", items: [] }])
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract.",
        schema: ChunkInvoice,
        chunkSize: 9,
        overlap: 0,
        chunker: fixedChunker(9),
      },
      { mode: "TOOLS" },
    )

    for (const outcome of result.chunks) {
      expect(DOC.slice(outcome.startIndex, outcome.endIndex).length).toBeGreaterThan(0)
    }
    expect(result.chunks[0]?.startIndex).toBe(0)
  })

  it("sends the chunk text as context so cited() can verify against it", async () => {
    const capture: RequestKwargs[] = []
    const client = chunkAwareClient([{ title: "T", items: [] }], capture)
    await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract.",
        schema: ChunkInvoice,
        chunkSize: 9,
        overlap: 0,
        chunker: fixedChunker(9),
      },
      { mode: "TOOLS" },
    )
    // The user message carries the chunk, not the whole document.
    const content = capture[0]?.messages[0]?.content
    expect(typeof content).toBe("string")
    expect(content).toContain("AAAA")
    expect(content).not.toContain("DDDD")
  })

  it("skips a chunk that exhausts retries and keeps the rest", async () => {
    const client = chunkAwareClient([
      { title: "Invoice", items: [{ id: 1 }] },
      new Error("boom"),
      { title: null, items: [{ id: 3 }] },
    ])
    const result = await createDocument(
      client,
      {
        document: "AAAA BBBB CCCC",
        model: "test-model",
        instruction: "Extract.",
        schema: Invoice,
        chunkSchema: ChunkInvoice,
        chunkSize: 5,
        overlap: 0,
        chunker: fixedChunker(5),
        maxRetries: 0,
      },
      { mode: "TOOLS" },
    )

    expect(result.data.items).toEqual([{ id: 1 }, { id: 3 }])
    expect(result.chunks[1]?.error).toBeInstanceOf(DocumentChunkError)
    expect(result.chunks[1]?.value).toBeUndefined()
    expect(result.chunks.filter((c) => c.error)).toHaveLength(1)
  })

  it("aborts on the first failed chunk when onChunkError is abort", async () => {
    const client = chunkAwareClient([
      new Error("boom"),
      { title: "Invoice", items: [] },
    ])
    await expect(
      createDocument(
        client,
        {
          document: DOC,
          model: "test-model",
          instruction: "Extract.",
          schema: ChunkInvoice,
          chunkSize: 9,
          overlap: 0,
          chunker: fixedChunker(9),
          onChunkError: "abort",
          maxRetries: 0,
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toBeInstanceOf(DocumentChunkError)
  })

  it("throws DocumentMergeError when no chunk satisfies the schema", async () => {
    const client = chunkAwareClient([{ title: null, items: [] }])
    await expect(
      createDocument(
        client,
        {
          document: DOC,
          model: "test-model",
          instruction: "Extract.",
          schema: Invoice,
          chunkSchema: ChunkInvoice,
          chunkSize: 9,
          overlap: 0,
          chunker: fixedChunker(9),
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toBeInstanceOf(DocumentMergeError)
  })

  it("throws DocumentNoDataError for a blank document", async () => {
    const client = chunkAwareClient([{ title: "T", items: [] }])
    await expect(
      createDocument(
        client,
        {
          document: "   \n\n ",
          model: "test-model",
          instruction: "Extract.",
          schema: Invoice,
          chunkSize: 9,
          overlap: 0,
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toBeInstanceOf(DocumentNoDataError)
  })

  it("propagates an abort that happens mid-flight instead of recording a chunk error", async () => {
    // One chunk only, so the loop's own throwIfAborted() on a later iteration
    // cannot mask whether the catch block rethrows the abort.
    const controller = new AbortController()
    const aborting: LLMClient = {
      async chatCompletionsCreate() {
        controller.abort()
        const error = new Error("The operation was aborted")
        error.name = "AbortError"
        throw error
      },
    }
    await expect(
      createDocument(
        aborting,
        {
          document: DOC,
          model: "test-model",
          instruction: "Extract.",
          schema: Invoice,
          chunkSize: 1000,
          overlap: 0,
          chunker: fixedChunker(1000),
          signal: controller.signal,
          maxRetries: 0,
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toThrow("aborted")
  })

  it("throws before any call when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const client = chunkAwareClient([{ title: "T", items: [] }])
    await expect(
      createDocument(
        client,
        {
          document: DOC,
          model: "test-model",
          instruction: "Extract.",
          schema: ChunkInvoice,
          chunkSize: 9,
          overlap: 0,
          chunker: fixedChunker(9),
          signal: controller.signal,
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toThrow()
  })

  it("defaults the chunk schema to the full schema", async () => {
    const client = chunkAwareClient([{ title: "Invoice", items: [{ id: 1 }] }])
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract.",
        schema: Invoice,
        // One chunk, so the assertion is about the default schema rather than
        // about how repeats across chunks merge.
        chunkSize: 1000,
        overlap: 0,
        chunker: fixedChunker(1000),
      },
      { mode: "TOOLS" },
    )
    expect(result.data).toEqual({ title: "Invoice", items: [{ id: 1 }] })
  })

  it("rejects a bad maxRetries before any chunk runs", async () => {
    // Without an up-front check the failure would repeat per chunk and the
    // catch would wrap the RangeError into a DocumentChunkError, burying it.
    const client = chunkAwareClient([{ title: "T", items: [] }])
    await expect(
      createDocument(
        client,
        {
          document: DOC,
          model: "test-model",
          instruction: "Extract.",
          schema: Invoice,
          chunkSize: 9,
          overlap: 0,
          chunker: fixedChunker(9),
          maxRetries: -1,
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toBeInstanceOf(RangeError)
  })
})

describe("createDocument with nothing to merge", () => {
  /** A schema with no required field, which `{}` satisfies. */
  const AllOptional = z.object({ title: z.string().optional() })

  it("throws DocumentNoDataError when every chunk fails", async () => {
    // The schema would have accepted `{}`, so this used to return a
    // successful-looking empty object while no answer ever arrived.
    const client = chunkAwareClient([new Error("network down")])
    try {
      await createDocument(
        client,
        {
          document: "a|b|c",
          model: "test-model",
          instruction: "Extract.",
          schema: AllOptional,
          chunkSize: 3,
          overlap: 0,
          chunker: fixedChunker(3),
          maxRetries: 0,
        },
        { mode: "TOOLS" },
      )
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentNoDataError)
      const noData = error as DocumentNoDataError
      expect(noData.reason).toBe("all-chunks-failed")
      expect(noData.chunkErrors.length).toBeGreaterThan(0)
    }
  })

  it("names the cause rather than blaming the schema", async () => {
    const client = chunkAwareClient([new Error("network down")])
    await expect(
      createDocument(
        client,
        {
          document: "a|b|c",
          model: "test-model",
          instruction: "Extract.",
          schema: AllOptional,
          chunkSize: 3,
          overlap: 0,
          chunker: fixedChunker(3),
          maxRetries: 0,
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toThrow(/chunk/i)
  })

  it("throws DocumentNoDataError for an empty document, with no chunks", async () => {
    const client = chunkAwareClient([{ title: "T" }])
    try {
      await createDocument(
        client,
        {
          document: "   \n\t ",
          model: "test-model",
          instruction: "Extract.",
          schema: AllOptional,
        },
        { mode: "TOOLS" },
      )
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentNoDataError)
      const noData = error as DocumentNoDataError
      expect(noData.reason).toBe("empty-document")
      expect(noData.chunkErrors).toEqual([])
      expect(noData.usage.totalTokens).toBe(0)
    }
  })

  it("still reports usage spent on chunks that all failed", async () => {
    // The run cost tokens even though it produced nothing, so the error must
    // not drop that on the floor. A payload that fails validation is used
    // rather than a thrown provider error, because only a real response carries
    // usage — a client that throws never reported any tokens.
    const client = chunkAwareClient([{ title: 123 }])
    try {
      await createDocument(
        client,
        {
          document: "a|b|c",
          model: "test-model",
          instruction: "Extract.",
          schema: AllOptional,
          chunkSize: 3,
          overlap: 0,
          chunker: fixedChunker(3),
          maxRetries: 0,
        },
        { mode: "TOOLS" },
      )
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentNoDataError)
      const noData = error as DocumentNoDataError
      expect(noData.reason).toBe("all-chunks-failed")
      expect(noData.usage.totalTokens).toBeGreaterThan(0)
    }
  })

  it("returns data as usual when at least one chunk succeeds", async () => {
    // The guard fires only when nothing succeeded, not merely when some failed.
    const client = chunkAwareClient([
      new Error("boom"),
      { title: "Invoice" },
    ])
    const result = await createDocument(
      client,
      {
        document: "AAAA BBBB",
        model: "test-model",
        instruction: "Extract.",
        schema: AllOptional,
        chunkSize: 5,
        overlap: 0,
        chunker: fixedChunker(5),
        maxRetries: 0,
      },
      { mode: "TOOLS" },
    )
    expect(result.data).toEqual({ title: "Invoice" })
    expect(result.chunks.filter((c) => c.error)).toHaveLength(1)
  })

  it("still throws DocumentMergeError when chunks succeeded but the merge fails", async () => {
    // A schema problem is a different failure: the chunks produced values, so
    // it must not be reported as "no data".
    const client = chunkAwareClient([{ title: null, items: [] }])
    await expect(
      createDocument(
        client,
        {
          document: DOC,
          model: "test-model",
          instruction: "Extract.",
          schema: Invoice,
          chunkSchema: ChunkInvoice,
          chunkSize: 9,
          overlap: 0,
          chunker: fixedChunker(9),
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toBeInstanceOf(DocumentMergeError)
  })
})

describe("createDocument overlap-aware dedupe", () => {
  const LineItems = z.object({
    items: z.array(z.object({ desc: z.string(), amount: z.number() })),
  })

  it("keeps two identical line items that sit in the same chunk", async () => {
    // Regression: global dedupe treated the invoice's real second "Coffee"
    // line as an overlap repeat and silently dropped it.
    const client = chunkAwareClient([
      {
        items: [
          { desc: "Coffee", amount: 5 },
          { desc: "Coffee", amount: 5 },
          { desc: "Tea", amount: 3 },
        ],
      },
    ])
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract every line item.",
        schema: LineItems,
        chunkSize: 1000,
        overlap: 0,
        chunker: fixedChunker(1000),
      },
      { mode: "TOOLS" },
    )
    expect(result.data.items).toEqual([
      { desc: "Coffee", amount: 5 },
      { desc: "Coffee", amount: 5 },
      { desc: "Tea", amount: 3 },
    ])
  })

  it("drops the repeat that overlapping windows cause", async () => {
    // Two windows that overlap by design, each reporting the same line.
    const client = chunkAwareClient([
      { items: [{ desc: "Coffee", amount: 5 }] },
      { items: [{ desc: "Coffee", amount: 5 }] },
    ])
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract every line item.",
        schema: LineItems,
        chunkSize: 10,
        overlap: 5,
        chunker: fixedChunker(10, 5),
      },
      { mode: "TOOLS" },
    )
    expect(result.data.items).toEqual([{ desc: "Coffee", amount: 5 }])
  })

  it("keeps every repeat when dedupe is none", async () => {
    const client = chunkAwareClient([
      { items: [{ desc: "Coffee", amount: 5 }] },
      { items: [{ desc: "Coffee", amount: 5 }] },
    ])
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract every line item.",
        schema: LineItems,
        chunkSize: 10,
        overlap: 5,
        chunker: fixedChunker(10, 5),
        dedupe: "none",
      },
      { mode: "TOOLS" },
    )
    expect(result.data.items).toEqual([
      { desc: "Coffee", amount: 5 },
      { desc: "Coffee", amount: 5 },
    ])
  })
})

describe("createDocument hook attribution", () => {
  it("gives every hook the chunk its event belongs to", async () => {
    // Three chunks; the hook must be able to tell them apart, which a plain
    // AttemptMeta cannot: attemptNumber resets at each chunk boundary.
    const client = chunkAwareClient([
      { title: "T", items: [] },
      { title: "T", items: [] },
      { title: "T", items: [] },
    ])
    const metas: AttemptMeta[] = []
    await createDocument(
      client,
      {
        document: "AAAA BBBB CCCC",
        model: "test-model",
        instruction: "Extract.",
        schema: ChunkInvoice,
        chunkSize: 5,
        overlap: 0,
        chunker: fixedChunker(5),
        hooks: {
          onSuccess: (_value, meta) => metas.push(meta),
        },
      },
      { mode: "TOOLS" },
    )

    expect(metas.map((meta) => meta.chunk?.index)).toEqual([0, 1, 2])
    // `total` makes progress computable without knowing the chunk count.
    expect(metas.map((meta) => meta.chunk?.total)).toEqual([3, 3, 3])
    // Offsets are absolute into the document, same as result.chunks[].
    expect(metas.map((meta) => [meta.chunk?.startIndex, meta.chunk?.endIndex])).toEqual([
      [0, 5],
      [5, 10],
      [10, 14],
    ])
  })

  it("keeps the chunk on every reask, not just the first attempt", async () => {
    // The issue's core complaint: a counter incremented per hook call reports
    // "chunk 6" for a two-chunk document, because one chunk emits several
    // parse errors. Each of those must name the chunk it came from.
    const client = chunkAwareClient([
      // Chunk 0: two failures, then a pass.
      { title: 1 },
      { title: 2 },
      { title: "T", items: [] },
      // Chunk 1: one failure, then a pass.
      { title: 3 },
      { title: "T", items: [] },
    ])
    const seen: Array<{ index: number | undefined; attempt: number }> = []
    await createDocument(
      client,
      {
        document: "AAAA BBBB",
        model: "test-model",
        instruction: "Extract.",
        schema: ChunkInvoice,
        chunkSize: 5,
        overlap: 0,
        chunker: fixedChunker(5),
        maxRetries: 3,
        hooks: {
          onParseError: (_error, meta) => {
            seen.push({ index: meta.chunk?.index, attempt: meta.attemptNumber })
          },
        },
      },
      { mode: "TOOLS" },
    )

    // attemptNumber restarts at each chunk; chunk.index is what disambiguates.
    expect(seen).toEqual([
      { index: 0, attempt: 1 },
      { index: 0, attempt: 2 },
      { index: 1, attempt: 1 },
    ])
  })

  it("leaves chunk absent for a plain create() call", async () => {
    // The document concept must not leak into the single-call path, so a
    // create() caller sees exactly the meta it saw before.
    const client = wrap(chunkAwareClient([{ title: "T", items: [] }]), {
      hooks: {
        onSuccess: (_value, meta) => {
          captured = meta
        },
      },
    })
    let captured: AttemptMeta | undefined
    await client.create({
      model: "test-model",
      schema: ChunkInvoice,
      messages: [{ role: "user", content: "x" }],
    })
    expect(captured).toBeDefined()
    expect("chunk" in (captured as AttemptMeta)).toBe(false)
  })
})

describe("createDocument with a non-object root schema", () => {
  it("concatenates a root array across chunks", async () => {
    const client = chunkAwareClient([[{ id: 1 }, { id: 2 }], [{ id: 3 }]])
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract every item.",
        schema: z.array(z.object({ id: z.number() })),
        chunkSize: 10,
        overlap: 0,
        chunker: fixedChunker(10),
      },
      { mode: "TOOLS" },
    )
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it("keeps a distinct Date reported by each chunk", async () => {
    // Regression: the dedupe key canonicalized every Date to "{}", so three
    // chunks reporting three different dates collapsed to one.
    const client = chunkAwareClient([
      { events: [{ when: "2020-01-01T00:00:00Z" }] },
      { events: [{ when: "2021-06-15T00:00:00Z" }] },
      { events: [{ when: "2023-12-31T00:00:00Z" }] },
    ])
    const result = await createDocument(
      client,
      {
        document: "AAAA BBBB CCCC",
        model: "test-model",
        instruction: "Extract the events.",
        schema: z.object({ events: z.array(z.object({ when: z.date() })) }),
        chunkSize: 5,
        overlap: 0,
        chunker: fixedChunker(5),
      },
      { mode: "TOOLS" },
    )
    expect(result.data.events.length).toBe(3)
    expect(result.data.events.map((event) => event.when.toISOString())).toEqual([
      "2020-01-01T00:00:00.000Z",
      "2021-06-15T00:00:00.000Z",
      "2023-12-31T00:00:00.000Z",
    ])
  })

  it("merges a scalar root from a Date-typed schema", async () => {
    // Regression: a Date root used to be dropped by the object-shaped merge,
    // failing with a message that blamed the schema.
    // The payload is a JSON string, so it is quoted for the tool arguments.
    const client = chunkAwareClient([
      '"2020-01-01T00:00:00Z"',
      '"2021-06-15T00:00:00Z"',
    ])
    const result = await createDocument(
      client,
      {
        document: DOC,
        model: "test-model",
        instruction: "Extract the date.",
        schema: z.date(),
        chunkSize: 10,
        overlap: 0,
        chunker: fixedChunker(10),
      },
      { mode: "TOOLS" },
    )
    expect(result.data).toBeInstanceOf(Date)
    expect(result.data.toISOString()).toBe("2020-01-01T00:00:00.000Z")
  })
})
