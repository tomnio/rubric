import { describe, expect, it } from "vitest"
import {
  chunkDocument,
  defaultChunker,
  type Chunker,
} from "../src/document/index.js"

const DOC = "Alpha one. Bravo two. Charlie three. Delta four."

/** A deterministic splitter: fixed-width windows over the document. */
function fixedChunker(size: number): Chunker {
  return async (document, { overlap }) => {
    const chunks = []
    for (let start = 0; start < document.length; start += size) {
      const end = Math.min(document.length, start + size)
      const startIndex = Math.max(0, start - overlap)
      const endIndex = Math.min(document.length, end + overlap)
      chunks.push({
        text: document.slice(startIndex, endIndex),
        startIndex,
        endIndex,
      })
    }
    return chunks
  }
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
})

describe("defaultChunker", () => {
  it("splits with @chonkiejs/core and reconstructs the document", async () => {
    const chunks = await defaultChunker(DOC, { chunkSize: 20, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    // Chonkie chunks are contiguous and lossless when overlap is off.
    const rebuilt = chunks.map((chunk) => chunk.text).join("")
    expect(rebuilt).toBe(DOC)
  })

  it("widens windows by overlap so a boundary is recoverable", async () => {
    const tight = await defaultChunker(DOC, { chunkSize: 20, overlap: 0 })
    const wide = await defaultChunker(DOC, { chunkSize: 20, overlap: 5 })
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
    const chunks = await defaultChunker(DOC, { chunkSize: 20, overlap: 5 })
    const covered = new Set<number>()
    for (const chunk of chunks) {
      for (let i = chunk.startIndex; i < chunk.endIndex; i += 1) {
        covered.add(i)
      }
    }
    // Every character index of the document sits inside at least one window.
    expect(covered.size).toBe(DOC.length)
  })
})
