import { describe, expect, it } from "vitest"
import { z } from "zod"
import { DocumentConflictError, type Chunker } from "../src/document/index.js"
import { mergeChunks, mergeInto, type ChunkValue } from "../src/document/merge.js"
import { type LLMClient } from "../src/index.js"

/** Chunks with overlapping windows, so equal values collapse as overlap repeats. */
function chunks(...values: unknown[]): ChunkValue[] {
  return values.map((value, index) => ({
    value,
    startIndex: index * 50,
    endIndex: index * 50 + 100,
  }))
}

describe("mergeChunks onConflict: first (default)", () => {
  it("keeps the first value and does not throw, as before", () => {
    const merged = mergeChunks(chunks({ total: 10 }, { total: 99 }))
    expect(merged).toEqual({ total: 10 })
  })

  it("is what an omitted option means", () => {
    expect(mergeChunks(chunks({ a: 1 }, { a: 2 }), {})).toEqual({ a: 1 })
    expect(
      mergeChunks(chunks({ a: 1 }, { a: 2 }), { onConflict: "first" }),
    ).toEqual({ a: 1 })
  })
})

describe("mergeChunks onConflict: error", () => {
  it("throws when two chunks disagree on a scalar", () => {
    expect(() =>
      mergeChunks(chunks({ total: 10 }, { total: 99 }), { onConflict: "error" }),
    ).toThrow(DocumentConflictError)
  })

  it("names the conflicting field and reports every value with its window", () => {
    const error = (() => {
      try {
        mergeChunks(chunks({ total: 10 }, { total: 99 }), {
          onConflict: "error",
        })
        return undefined
      } catch (err) {
        return err as DocumentConflictError
      }
    })()

    expect(error).toBeInstanceOf(DocumentConflictError)
    expect(error?.conflicts).toHaveLength(1)
    const conflict = error?.conflicts[0]
    expect(conflict?.key).toBe("total")
    // Every disagreeing value, in chunk order, each with the window it came from.
    expect(conflict?.values).toEqual([
      { value: 10, startIndex: 0, endIndex: 100 },
      { value: 99, startIndex: 50, endIndex: 150 },
    ])
    expect(error?.message).toMatch(/total/)
  })

  it("does not throw when every chunk agrees", () => {
    const merged = mergeChunks(
      chunks({ total: 10 }, { total: 10 }, { total: 10 }),
      { onConflict: "error" },
    )
    expect(merged).toEqual({ total: 10 })
  })

  it("treats an overlap repeat as agreement, not a conflict", () => {
    // The common case: two overlapping windows read the same text, so they
    // report the same value. Structural equality keeps this from failing.
    const merged = mergeChunks(
      chunks({ seller: { name: "Acme", city: "Berlin" } }, { seller: { city: "Berlin", name: "Acme" } }),
      { onConflict: "error" },
    )
    expect(merged).toEqual({ seller: { name: "Acme", city: "Berlin" } })
  })

  it("treats null as absence, not as a disagreeing value", () => {
    // A chunk-tolerant schema reports unseen fields as null. If null counted as
    // a value, `onConflict: "error"` would be unusable with the schema the
    // document API tells callers to write.
    const merged = mergeChunks(
      chunks({ title: null }, { title: "Invoice" }, { title: "Invoice" }),
      { onConflict: "error" },
    )
    expect(merged).toEqual({ title: "Invoice" })
  })

  it("does not treat a null-only field as a conflict", () => {
    const merged = mergeChunks(chunks({ note: null }, { note: null }), {
      onConflict: "error",
    })
    expect(merged).toEqual({ note: null })
  })

  it("reports a conflict on a nested object, which is an atomic value", () => {
    // Nested objects are not merged field by field, so two different ones are a
    // real disagreement — the same silent loss a scalar conflict is.
    const error = (() => {
      try {
        mergeChunks(
          chunks({ seller: { name: "Acme" } }, { seller: { name: "Globex" } }),
          { onConflict: "error" },
        )
        return undefined
      } catch (err) {
        return err as DocumentConflictError
      }
    })()

    expect(error).toBeInstanceOf(DocumentConflictError)
    expect(error?.conflicts[0]?.key).toBe("seller")
  })

  it("does not report array fields, which concatenate", () => {
    const merged = mergeChunks(
      chunks({ items: [{ id: 1 }] }, { items: [{ id: 2 }] }),
      { onConflict: "error" },
    )
    expect(merged).toEqual({ items: [{ id: 1 }, { id: 2 }] })
  })

  it("reports every conflicting field, not just the first", () => {
    const error = (() => {
      try {
        mergeChunks(chunks({ a: 1, b: "x" }, { a: 2, b: "y" }), {
          onConflict: "error",
        })
        return undefined
      } catch (err) {
        return err as DocumentConflictError
      }
    })()

    expect(error?.conflicts.map((conflict) => conflict.key).sort()).toEqual([
      "a",
      "b",
    ])
  })

  it("compares Date values by instant, like array dedupe does", () => {
    // Two Dates holding the same instant are equal, so they are not a conflict.
    const merged = mergeChunks(
      chunks(
        { when: new Date("2026-01-01T00:00:00Z") },
        { when: new Date("2026-01-01T00:00:00Z") },
      ),
      { onConflict: "error" },
    )
    expect(merged).toEqual({ when: new Date("2026-01-01T00:00:00Z") })

    // Different instants are.
    expect(() =>
      mergeChunks(
        chunks(
          { when: new Date("2026-01-01T00:00:00Z") },
          { when: new Date("2026-06-01T00:00:00Z") },
        ),
        { onConflict: "error" },
      ),
    ).toThrow(DocumentConflictError)
  })
})

describe("mergeInto onConflict: error", () => {
  const Schema = z.object({ total: z.number() })

  it("throws before validating, so the conflict is not masked by a schema error", () => {
    const error = (() => {
      try {
        mergeInto(Schema, chunks({ total: 10 }, { total: 99 }), [], {
          onConflict: "error",
        })
        return undefined
      } catch (err) {
        return err
      }
    })()

    expect(error).toBeInstanceOf(DocumentConflictError)
  })

  it("carries the chunk errors it was given", () => {
    const chunkError = { index: 0 } as never
    const error = (() => {
      try {
        mergeInto(Schema, chunks({ total: 10 }, { total: 99 }), [chunkError], {
          onConflict: "error",
        })
        return undefined
      } catch (err) {
        return err as DocumentConflictError
      }
    })()

    expect(error?.chunkErrors).toEqual([chunkError])
  })

  it("returns the parsed value when there is no conflict", () => {
    const parsed = mergeInto(Schema, chunks({ total: 10 }, { total: 10 }), [], {
      onConflict: "error",
    })
    expect(parsed).toEqual({ total: 10 })
  })

  it("reports a scalar-root conflict under a synthetic key", () => {
    const error = (() => {
      try {
        mergeInto(z.string(), chunks("a", "b"), [], { onConflict: "error" })
        return undefined
      } catch (err) {
        return err as DocumentConflictError
      }
    })()

    expect(error).toBeInstanceOf(DocumentConflictError)
    expect(error?.conflicts[0]?.key).toBe("(root)")
  })

  it("does not report a scalar root that agrees", () => {
    expect(
      mergeInto(z.string(), chunks("a", "a"), [], { onConflict: "error" }),
    ).toBe("a")
  })

  it("does not report a root array, which concatenates", () => {
    expect(
      mergeInto(z.array(z.string()), chunks(["a"], ["b"]), [], {
        onConflict: "error",
      }),
    ).toEqual(["a", "b"])
  })

  it("ignores nulls for a scalar root too", () => {
    expect(
      mergeInto(z.string(), chunks(null, "a", "a"), [], { onConflict: "error" }),
    ).toBe("a")
  })
})

describe("createDocument onConflict", () => {
  const Statement = z.object({ statement: z.string() })

  /** One chunk per `size` characters. */
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

  function run(client: LLMClient, onConflict?: "first" | "error") {
    return mergeDocument(client, onConflict)
  }

  function mergeDocument(
    client: LLMClient,
    onConflict: "first" | "error" | undefined,
  ) {
    return import("../src/document/index.js").then(({ createDocument }) =>
      createDocument(client, {
        model: "test-model",
        document: "A".repeat(20),
        instruction: "Extract.",
        schema: Statement,
        chunkSize: 10,
        overlap: 0,
        chunker: fixedChunker(10),
        ...(onConflict !== undefined ? { onConflict } : {}),
      }),
    )
  }

  it("keeps the first value by default when chunks disagree", async () => {
    const result = await run(
      sequenceClient([{ statement: "first" }, { statement: "second" }]),
    )
    expect(result.data.statement).toBe("first")
  })

  it("throws DocumentConflictError under onConflict: error", async () => {
    await expect(
      run(
        sequenceClient([{ statement: "first" }, { statement: "second" }]),
        "error",
      ),
    ).rejects.toBeInstanceOf(DocumentConflictError)
  })

  it("returns normally under onConflict: error when chunks agree", async () => {
    const result = await run(
      sequenceClient([{ statement: "same" }, { statement: "same" }]),
      "error",
    )
    expect(result.data.statement).toBe("same")
  })
})
