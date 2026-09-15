import { describe, expect, it } from "vitest"
import { z } from "zod"
import { DocumentMergeError } from "../src/document/index.js"
import { mergeChunks, mergeInto } from "../src/document/merge.js"

describe("mergeChunks", () => {
  it("concatenates array fields across chunks", () => {
    const merged = mergeChunks([
      { items: [{ id: 1 }, { id: 2 }] },
      { items: [{ id: 3 }] },
    ])
    expect(merged).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] })
  })

  it("drops array entries that are deep-equal across chunks", () => {
    // Overlapping windows are expected to re-report the same item.
    const merged = mergeChunks([
      { items: [{ id: 1 }, { id: 2 }] },
      { items: [{ id: 2 }, { id: 3 }] },
    ])
    expect(merged).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] })
  })

  it("dedupes regardless of key order inside an object", () => {
    const merged = mergeChunks([
      { items: [{ a: 1, b: 2 }] },
      { items: [{ b: 2, a: 1 }] },
    ])
    expect(merged).toEqual({ items: [{ a: 1, b: 2 }] })
  })

  it("takes the first non-null scalar in chunk order", () => {
    const merged = mergeChunks([
      { title: null },
      { title: "Invoice" },
      { title: "Other" },
    ])
    expect(merged).toEqual({ title: "Invoice" })
  })

  it("takes the first scalar even when a later chunk disagrees", () => {
    // Documented lossy behaviour: no semantic reconciliation.
    const merged = mergeChunks([{ total: 10 }, { total: 99 }])
    expect(merged).toEqual({ total: 10 })
  })

  it("keeps fields that only some chunks reported", () => {
    const merged = mergeChunks([
      { title: "Invoice" },
      { items: [{ id: 1 }] },
    ])
    expect(merged).toEqual({ title: "Invoice", items: [{ id: 1 }] })
  })

  it("omits a field no chunk reported", () => {
    const merged = mergeChunks([{ a: 1 }, { b: 2 }])
    expect("missing" in merged).toBe(false)
  })

  it("preserves an explicit null when every chunk reported null", () => {
    // A nullable field must stay present so it validates rather than looking absent.
    const merged = mergeChunks([{ note: null }, { note: null }])
    expect(merged).toEqual({ note: null })
  })

  it("treats a nested object as an atomic value", () => {
    const merged = mergeChunks([
      { seller: { name: "Acme", city: "Berlin" } },
      { seller: { name: "Acme", city: "Munich" } },
    ])
    expect(merged).toEqual({ seller: { name: "Acme", city: "Berlin" } })
  })

  it("merges array fields even when other chunks omit them", () => {
    const merged = mergeChunks([{ items: [{ id: 1 }] }, { title: "x" }])
    expect(merged).toEqual({ items: [{ id: 1 }], title: "x" })
  })

  it("returns an empty object for no results", () => {
    expect(mergeChunks([])).toEqual({})
  })
})

describe("mergeInto", () => {
  const Invoice = z.object({
    title: z.string(),
    items: z.array(z.object({ id: z.number() })),
  })

  it("returns the parsed value when the merge satisfies the schema", () => {
    const data = mergeInto(Invoice, [
      { title: "Invoice", items: [{ id: 1 }] },
      { items: [{ id: 2 }] },
    ])
    expect(data).toEqual({ title: "Invoice", items: [{ id: 1 }, { id: 2 }] })
  })

  it("throws DocumentMergeError when a required field is missing", () => {
    expect(() => mergeInto(Invoice, [{ items: [] }])).toThrow(DocumentMergeError)
  })

  it("carries the partial value and chunk errors on the error", () => {
    try {
      mergeInto(Invoice, [{ items: [] }])
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(DocumentMergeError)
      const mergeError = error as DocumentMergeError
      expect(mergeError.partial).toEqual({ items: [] })
      expect(mergeError.issues.length).toBeGreaterThan(0)
      expect(mergeError.chunkErrors).toEqual([])
    }
  })
})
