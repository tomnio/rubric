import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createDocument,
  DocumentChunkError,
  DocumentMergeError,
  type Chunker,
  type DocumentChunk,
} from "../src/document/index.js"
import type { LLMClient, RequestKwargs } from "../src/index.js"

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

  it("throws DocumentMergeError for a blank document", async () => {
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
    ).rejects.toBeInstanceOf(DocumentMergeError)
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
        chunkSize: 9,
        overlap: 0,
        chunker: fixedChunker(9),
      },
      { mode: "TOOLS" },
    )
    expect(result.data).toEqual({ title: "Invoice", items: [{ id: 1 }] })
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
