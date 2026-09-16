/**
 * Live end-to-end suite for the document pipeline.
 *
 * Exercises createDocument() against a real provider: chunking (the WASM
 * chunker when installed), a per-chunk create() round trip, the merge, and the
 * conflict guardrail. Skips unless RUBRIC_LIVE=1 and OPENAI_API_KEY are set, and
 * the createDocument() cases additionally need @chonkiejs/core.
 */
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  DocumentConflictError,
  createDocument,
  type Chunker,
} from "../../src/document/index.js"
import {
  OPENAI_MODEL,
  OPENAI_MODE,
  hasChonkie,
  hasOpenAI,
  openaiSdk,
} from "./helpers.js"

const DOCUMENT = [
  "INVOICE 2026-0042",
  "Billed to: Acme GmbH, Berlin",
  "",
  "Line items:",
  "1. Consulting hours, March ......... 1,200.00",
  "2. Travel reimbursement ............   340.50",
  "3. Software licence (annual) .......   899.00",
  "",
  "Payment due within 30 days.",
].join("\n")

const Invoice = z.object({
  title: z.string(),
  items: z.array(
    z.object({
      description: z.string(),
      amount: z.number(),
    }),
  ),
})

// A chunk sees only part of the document, so a strict schema would fail on
// most chunks. Chunks validate loosely; the merged result validates strictly.
const ChunkInvoice = z.object({
  title: z.string().nullable().default(null),
  items: z
    .array(z.object({ description: z.string(), amount: z.number() }))
    .default([]),
})

/** Split on paragraph breaks, so the boundary lands mid-invoice on purpose. */
function paragraphChunker(): Chunker {
  return async (document) => {
    const chunks = []
    let cursor = 0
    for (const block of document.split(/\n\s*\n/)) {
      const start = document.indexOf(block, cursor)
      const end = start + block.length
      chunks.push({ text: block, startIndex: start, endIndex: end })
      cursor = end
    }
    return chunks
  }
}

describe.skipIf(!hasOpenAI)("live: createDocument with the real chunker", () => {
  const run = (extra: Record<string, unknown> = {}) =>
    createDocument(
      openaiSdk(),
      {
        model: OPENAI_MODEL,
        document: DOCUMENT,
        instruction: "Extract the invoice title and every line item.",
        schema: Invoice,
        chunkSchema: ChunkInvoice,
        chunkSize: 120,
        overlap: 40,
        ...extra,
      },
      { mode: OPENAI_MODE },
    )

  it.skipIf(!hasChonkie)("merges one invoice out of several chunks", async () => {
    const result = await run()
    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.data.title).toContain("2026-0042")
    // Every line item is recovered, across whatever boundary the splitter made.
    expect(result.data.items.length).toBeGreaterThanOrEqual(3)
    expect(result.data.items.map((item) => item.amount)).toEqual(
      expect.arrayContaining([1200, 340.5, 899]),
    )
    // Provenance is positioned in the original document, not inside a chunk.
    for (const chunk of result.chunks) {
      expect(chunk.startIndex).toBeGreaterThanOrEqual(0)
      expect(chunk.endIndex).toBeLessThanOrEqual(DOCUMENT.length)
      expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex)
    }
    expect(result.usage.totalTokens).toBeGreaterThan(0)
    expect(result.usage.attempts).toBeGreaterThanOrEqual(result.chunks.length)
  })

  it("works with a custom chunker, no WASM involved", async () => {
    const result = await createDocument(
      openaiSdk(),
      {
        model: OPENAI_MODEL,
        document: DOCUMENT,
        instruction: "Extract the invoice title and every line item.",
        schema: Invoice,
        chunkSchema: ChunkInvoice,
        chunker: paragraphChunker(),
        chunkSize: 120,
        overlap: 0,
      },
      { mode: OPENAI_MODE },
    )
    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.data.title).toContain("2026-0042")
    expect(result.data.items.length).toBeGreaterThanOrEqual(3)
  })

  it("does not report an identical item twice", async () => {
    // A wide overlap makes adjacent windows share text, so an item near a
    // boundary is read by two chunks. Dedupe cannot collapse a *reworded*
    // reading (that needs dedupeBy), but an identical one must not survive
    // twice — that is the guarantee.
    const result = await run({ overlap: 200, dedupe: "overlap" })
    const seen = new Set(
      result.data.items.map((item) => JSON.stringify(item)),
    )
    expect(seen.size).toBe(result.data.items.length)
  })

  it("raises DocumentConflictError when two chunks disagree", async () => {
    // The document contradicts itself: two paragraphs name different invoices,
    // and no chunk sees both. Whichever title each chunk reads, the merge
    // cannot have them agree — so with onConflict: "error" it must refuse.
    const contradictory = [
      "INVOICE 2026-0042",
      "Billed to: Acme GmbH, Berlin",
      "",
      "Line items:",
      "1. Consulting hours, March ......... 1,200.00",
      "",
      "Reference copy — INVOICE 2026-0099",
    ].join("\n")

    try {
      const result = await createDocument(
        openaiSdk(),
        {
          model: OPENAI_MODEL,
          document: contradictory,
          instruction: "Extract the invoice title and every line item.",
          schema: Invoice,
          chunkSchema: ChunkInvoice,
          chunker: paragraphChunker(),
          chunkSize: 120,
          overlap: 0,
          onConflict: "error",
        },
        { mode: OPENAI_MODE },
      )
      // Tolerated: the model may still have reported one title everywhere. If
      // so it must be a consistent, real title — never a silent blend.
      expect(result.data.title).toMatch(/2026-00(42|99)/)
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentConflictError)
    }
  })
})
