import { describe, expect, it, vi } from "vitest"
import {
  chunkDocument,
  defaultChunker,
  type Chunker,
} from "../src/document/index.js"

const DOC = "Alpha one. Bravo two. Charlie three. Delta four."

/**
 * A deterministic splitter: fixed-width, contiguous windows. It deliberately
 * does NOT widen by overlap — that is the pipeline's job, and this is the
 * custom chunker the issue is about.
 */
function fixedChunker(size: number): Chunker {
  return async (document) => {
    const chunks = []
    for (let start = 0; start < document.length; start += size) {
      const end = Math.min(document.length, start + size)
      chunks.push({ text: document.slice(start, end), startIndex: start, endIndex: end })
    }
    return chunks
  }
}

/** Every character index covered by at least one window. */
function covered(document: string, chunks: Array<{ startIndex: number; endIndex: number }>): number {
  const seen = new Set<number>()
  for (const chunk of chunks) {
    for (let i = chunk.startIndex; i < chunk.endIndex; i += 1) {
      seen.add(i)
    }
  }
  return seen.size
}

describe("chunkDocument", () => {
  it("returns no chunks for a blank document", async () => {
    expect(await chunkDocument("   \n\n  ", { chunkSize: 20, overlap: 0 })).toEqual([])
  })

  it("uses an injected chunker", async () => {
    const chunks = await chunkDocument(DOC, {
      chunkSize: 20,
      overlap: 0,
      chunker: fixedChunker(20),
    })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]).toEqual({ text: DOC.slice(0, 20), startIndex: 0, endIndex: 20 })
  })

  it("positions chunks in the original document", async () => {
    const chunks = await chunkDocument(DOC, {
      chunkSize: 20,
      overlap: 0,
      chunker: fixedChunker(20),
    })
    for (const chunk of chunks) {
      expect(DOC.slice(chunk.startIndex, chunk.endIndex)).toBe(chunk.text)
    }
  })

  it("widens a custom chunker's windows, so overlap is never silently lost", async () => {
    // The issue: a custom chunker that ignores overlap used to lose boundary
    // recovery with no signal. Widening now happens in the pipeline, so it
    // holds regardless of what the chunker does.
    const tight = await chunkDocument(DOC, {
      chunkSize: 20,
      overlap: 0,
      chunker: fixedChunker(20),
    })
    const wide = await chunkDocument(DOC, {
      chunkSize: 20,
      overlap: 5,
      chunker: fixedChunker(20),
    })
    expect(wide.length).toBe(tight.length)
    const tightSecond = tight[1]!
    const wideSecond = wide[1]!
    expect(wideSecond.startIndex).toBe(tightSecond.startIndex - 5)
    expect(wideSecond.endIndex).toBe(tightSecond.endIndex + 5)
    expect(wideSecond.text).toContain(tightSecond.text)
  })

  it("does not hand overlap to the chunker, so it cannot be applied twice", async () => {
    // Structural guard: the pipeline owns widening, and a chunker that widened
    // its own windows would double it. Keeping the option out of the chunker's
    // reach makes that impossible rather than merely discouraged.
    const seen: Array<Record<string, unknown>> = []
    const spy: Chunker = async (document, options) => {
      seen.push(options as unknown as Record<string, unknown>)
      return fixedChunker(20)(document, options)
    }
    await chunkDocument(DOC, { chunkSize: 20, overlap: 5, chunker: spy })
    expect(seen).toEqual([{ chunkSize: 20 }])
  })

  it("covers every position for a custom chunker when overlap is on", async () => {
    const chunks = await chunkDocument(DOC, {
      chunkSize: 20,
      overlap: 5,
      chunker: fixedChunker(20),
    })
    expect(covered(DOC, chunks)).toBe(DOC.length)
  })
})

describe("defaultChunker", () => {
  it("splits with @chonkiejs/core and reconstructs the document", async () => {
    const chunks = await defaultChunker(DOC, { chunkSize: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    // Chonkie chunks are contiguous and lossless; widening is the pipeline's.
    const rebuilt = chunks.map((chunk) => chunk.text).join("")
    expect(rebuilt).toBe(DOC)
  })

  it("is widened by chunkDocument, not by the chunker itself", async () => {
    const tight = await chunkDocument(DOC, { chunkSize: 20, overlap: 0 })
    const wide = await chunkDocument(DOC, { chunkSize: 20, overlap: 5 })
    expect(tight.length).toBe(wide.length)

    const tightSecond = tight[1]!
    const wideSecond = wide[1]!
    // Overlap reaches back before the tight start and forward past the tight
    // end, so content cut at the boundary appears whole in one window.
    expect(wideSecond.startIndex).toBe(tightSecond.startIndex - 5)
    expect(wideSecond.endIndex).toBe(tightSecond.endIndex + 5)
    expect(wideSecond.text).toContain(tightSecond.text)
  })

  it("covers every position when overlap is on, so nothing falls between chunks", async () => {
    const chunks = await chunkDocument(DOC, { chunkSize: 20, overlap: 5 })
    expect(covered(DOC, chunks)).toBe(DOC.length)
  })
})
