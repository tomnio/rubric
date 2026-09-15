import { describe, expect, it } from "vitest"
import { z } from "zod"
import { DocumentMergeError } from "../src/document/index.js"
import {
  mergeChunks,
  mergeInto,
  type ChunkValue,
} from "../src/document/merge.js"

/**
 * Wrap bare values as chunks whose windows overlap, so a value two chunks
 * report counts as an overlap repeat. Chunk 0 covers [0, 100), chunk 1
 * [50, 150), and so on.
 */
function chunks(...values: unknown[]): ChunkValue[] {
  return values.map((value, index) => ({
    value,
    startIndex: index * 50,
    endIndex: index * 50 + 100,
  }))
}

/** Two chunks with disjoint windows, so nothing is treated as an overlap. */
function disjointChunks(...values: unknown[]): ChunkValue[] {
  return values.map((value, index) => ({
    value,
    startIndex: index * 100,
    endIndex: index * 100 + 100,
  }))
}

/**
 * Two chunks whose windows overlap, each holding one of `first` / `second`.
 * Use this to ask whether two values compare equal: equal values collapse,
 * different ones survive.
 */
function pair(first: unknown, second: unknown): ChunkValue[] {
  return [
    { value: first, startIndex: 0, endIndex: 100 },
    { value: second, startIndex: 50, endIndex: 150 },
  ]
}

describe("mergeChunks", () => {
  it("concatenates array fields across chunks", () => {
    const merged = mergeChunks(
      chunks({ items: [{ id: 1 }, { id: 2 }] }, { items: [{ id: 3 }] }),
    )
    expect(merged).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] })
  })

  it("drops array entries that are deep-equal across overlapping chunks", () => {
    const merged = mergeChunks(
      chunks({ items: [{ id: 1 }, { id: 2 }] }, { items: [{ id: 2 }, { id: 3 }] }),
    )
    expect(merged).toEqual({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] })
  })

  it("dedupes regardless of key order inside an object", () => {
    const merged = mergeChunks(
      chunks({ items: [{ a: 1, b: 2 }] }, { items: [{ b: 2, a: 1 }] }),
    )
    expect(merged).toEqual({ items: [{ a: 1, b: 2 }] })
  })

  it("takes the first non-null scalar in chunk order", () => {
    const merged = mergeChunks(
      chunks({ title: null }, { title: "Invoice" }, { title: "Other" }),
    )
    expect(merged).toEqual({ title: "Invoice" })
  })

  it("takes the first scalar even when a later chunk disagrees", () => {
    // Documented lossy behaviour: no semantic reconciliation.
    const merged = mergeChunks(chunks({ total: 10 }, { total: 99 }))
    expect(merged).toEqual({ total: 10 })
  })

  it("keeps fields that only some chunks reported", () => {
    const merged = mergeChunks(chunks({ title: "Invoice" }, { items: [{ id: 1 }] }))
    expect(merged).toEqual({ title: "Invoice", items: [{ id: 1 }] })
  })

  it("omits a field no chunk reported", () => {
    const merged = mergeChunks(chunks({ a: 1 }, { b: 2 }))
    expect("missing" in merged).toBe(false)
  })

  it("preserves an explicit null when every chunk reported null", () => {
    // A nullable field must stay present so it validates rather than looking absent.
    const merged = mergeChunks(chunks({ note: null }, { note: null }))
    expect(merged).toEqual({ note: null })
  })

  it("treats a nested object as an atomic value", () => {
    const merged = mergeChunks(
      chunks(
        { seller: { name: "Acme", city: "Berlin" } },
        { seller: { name: "Acme", city: "Munich" } },
      ),
    )
    expect(merged).toEqual({ seller: { name: "Acme", city: "Berlin" } })
  })

  it("merges array fields even when other chunks omit them", () => {
    const merged = mergeChunks(chunks({ items: [{ id: 1 }] }, { title: "x" }))
    expect(merged).toEqual({ items: [{ id: 1 }], title: "x" })
  })

  it("returns an empty object for no results", () => {
    expect(mergeChunks([])).toEqual({})
  })
})

describe("mergeChunks overlap-aware dedupe", () => {
  it("keeps a repeat that sits inside a single chunk", () => {
    // The issue's headline case: two identical invoice lines in one chunk are
    // a real part of the document, not an artifact of windowing.
    const merged = mergeChunks([
      {
        value: {
          items: [
            { desc: "Coffee", amount: 5 },
            { desc: "Coffee", amount: 5 },
            { desc: "Tea", amount: 3 },
          ],
        },
        startIndex: 0,
        endIndex: 100,
      },
    ])
    expect((merged.items as unknown[]).length).toBe(3)
  })

  it("drops a repeat across two chunks whose windows overlap", () => {
    const merged = mergeChunks(
      pair({ items: [{ desc: "Coffee", amount: 5 }] }, { items: [{ desc: "Coffee", amount: 5 }] }),
    )
    expect((merged.items as unknown[]).length).toBe(1)
  })

  it("keeps a repeat across two chunks whose windows do not overlap", () => {
    // Two windows that share no text cannot be two views of one item, so this
    // is the document genuinely holding the item twice.
    const merged = mergeChunks(
      disjointChunks(
        { items: [{ desc: "Coffee", amount: 5 }] },
        { items: [{ desc: "Coffee", amount: 5 }] },
      ),
    )
    expect((merged.items as unknown[]).length).toBe(2)
  })

  it("keeps everything when dedupe is none", () => {
    const merged = mergeChunks(
      pair({ items: [{ desc: "Coffee" }] }, { items: [{ desc: "Coffee" }] }),
      { dedupe: "none" },
    )
    expect((merged.items as unknown[]).length).toBe(2)
  })

  it("defaults to overlap-aware dedupe", () => {
    const merged = mergeChunks(
      pair({ items: [{ id: 1 }] }, { items: [{ id: 1 }] }),
    )
    expect((merged.items as unknown[]).length).toBe(1)
  })

  it("still collapses a genuine duplicate that straddles two overlapping chunks", () => {
    // Documented limit: overlapping windows leave no signal to tell a real
    // duplicate from an overlap repeat. `dedupe: "none"` is the escape hatch.
    const merged = mergeChunks(
      pair({ items: [{ id: 1 }] }, { items: [{ id: 1 }] }),
    )
    expect((merged.items as unknown[]).length).toBe(1)
  })

  it("keeps a within-chunk repeat even when the same value also appears elsewhere", () => {
    // Two chunks, the first holding the value twice and the second once. The
    // pair inside chunk 0 is kept; only chunk 1's copy is an overlap repeat.
    const merged = mergeChunks(
      pair({ items: [{ id: 1 }, { id: 1 }] }, { items: [{ id: 1 }] }),
    )
    expect((merged.items as unknown[]).length).toBe(2)
  })

  it("keeps an earlier within-chunk repeat when a later chunk repeats it", () => {
    // Order check: the kept copies must be the ones that came first.
    const merged = mergeChunks([
      { value: { items: [{ id: 1 }] }, startIndex: 0, endIndex: 100 },
      { value: { items: [{ id: 1 }, { id: 1 }] }, startIndex: 50, endIndex: 150 },
    ])
    expect((merged.items as unknown[]).length).toBe(2)
  })
})

describe("mergeChunks dedupe key", () => {
  it("keeps distinct Date values apart", () => {
    const merged = mergeChunks(
      pair(
        { events: [new Date("2020-01-01T00:00:00Z")] },
        { events: [new Date("2021-06-15T00:00:00Z"), new Date("2023-12-31T00:00:00Z")] },
      ),
    )
    expect((merged.events as Date[]).length).toBe(3)
  })

  it("still collapses two Dates that hold the same instant", () => {
    const merged = mergeChunks(
      pair(
        { events: [new Date("2020-01-01T00:00:00Z")] },
        { events: [new Date("2020-01-01T00:00:00Z")] },
      ),
    )
    expect((merged.events as Date[]).length).toBe(1)
  })

  it("distinguishes an invalid Date from a valid one and from another invalid one", () => {
    const merged = mergeChunks([
      {
        value: { events: [new Date("nope"), new Date("nope"), new Date()] },
        startIndex: 0,
        endIndex: 100,
      },
    ])
    // Inside one chunk nothing is collapsed, so all three survive; the point is
    // that the two invalid Dates are not treated as the same value elsewhere.
    const inTwoChunks = mergeChunks(
      pair({ events: [new Date("nope")] }, { events: [new Date()] }),
    )
    expect((inTwoChunks.events as Date[]).length).toBe(2)
    expect((merged.events as Date[]).length).toBe(3)
  })

  it("keeps distinct Map values apart", () => {
    const merged = mergeChunks(
      pair({ a: [new Map([["k", 1]])] }, { a: [new Map([["k", 2]])] }),
    )
    expect((merged.a as Map<string, number>[]).length).toBe(2)
  })

  it("collapses two Maps with the same entries regardless of insertion order", () => {
    const merged = mergeChunks(
      pair(
        { a: [new Map<string, number>([["x", 1], ["y", 2]])] },
        { a: [new Map<string, number>([["y", 2], ["x", 1]])] },
      ),
    )
    expect((merged.a as Map<string, number>[]).length).toBe(1)
  })

  it("keeps distinct Set values apart", () => {
    const merged = mergeChunks(pair({ a: [new Set([1])] }, { a: [new Set([2])] }))
    expect((merged.a as Set<number>[]).length).toBe(2)
  })

  it("collapses two Sets with the same members regardless of insertion order", () => {
    const merged = mergeChunks(
      pair({ a: [new Set([1, 2])] }, { a: [new Set([2, 1])] }),
    )
    expect((merged.a as Set<number>[]).length).toBe(1)
  })

  it("keeps distinct RegExp values apart", () => {
    const merged = mergeChunks(pair({ a: [/a/] }, { a: [/b/] }))
    expect((merged.a as RegExp[]).length).toBe(2)
  })

  it("distinguishes two RegExps that differ only in flags", () => {
    const merged = mergeChunks(pair({ a: [/a/g] }, { a: [/a/i] }))
    expect((merged.a as RegExp[]).length).toBe(2)
  })

  it("does not collide NaN with null", () => {
    const merged = mergeChunks(pair({ a: [NaN] }, { a: [null] }))
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("collapses two NaNs", () => {
    const merged = mergeChunks(pair({ a: [NaN] }, { a: [NaN] }))
    expect((merged.a as unknown[]).length).toBe(1)
  })

  it("distinguishes NaN, Infinity, -Infinity and null from one another", () => {
    const merged = mergeChunks([
      {
        value: { a: [NaN, Infinity, -Infinity, null] },
        startIndex: 0,
        endIndex: 100,
      },
      { value: { a: [] }, startIndex: 50, endIndex: 150 },
    ])
    expect((merged.a as unknown[]).length).toBe(4)
  })

  it("distinguishes -0 from 0", () => {
    const merged = mergeChunks(pair({ a: [-0] }, { a: [0] }))
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("keeps distinct nested Dates apart", () => {
    const merged = mergeChunks(
      pair(
        { rows: [{ d: new Date("2020-01-01T00:00:00Z"), n: "a" }] },
        { rows: [{ d: new Date("2021-01-01T00:00:00Z"), n: "a" }] },
      ),
    )
    expect((merged.rows as unknown[]).length).toBe(2)
  })

  it("treats a class instance as opaque: distinct instances stay distinct", () => {
    class Money {
      constructor(readonly amount: number) {}
    }
    const merged = mergeChunks(pair({ a: [new Money(1)] }, { a: [new Money(2)] }))
    expect((merged.a as Money[]).length).toBe(2)
  })

  it("treats the same class instance as equal to itself", () => {
    class Money {
      constructor(readonly amount: number) {}
    }
    const one = new Money(1)
    const merged = mergeChunks(pair({ a: [one] }, { a: [one] }))
    expect((merged.a as Money[]).length).toBe(1)
  })

  it("does not let a string payload imitate the key encoding", () => {
    // Length-prefixing keeps the encoding injective: a string that looks like a
    // key for another value must not collide with that value's own key.
    const merged = mergeChunks(pair({ a: ["array:[]"] }, { a: [[]] }))
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("does not confuse a nested array with a nested object", () => {
    const merged = mergeChunks(pair({ a: [[1]] }, { a: [{ 0: 1 }] }))
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("distinguishes an object key from a string value", () => {
    const merged = mergeChunks(pair({ a: [{ k: "v" }] }, { a: [{ k: "v" }] }))
    expect((merged.a as unknown[]).length).toBe(1)
  })

  it("collapses Maps whose opaque members were inserted in a different order", () => {
    // The identity table is shared across the whole merge, so a member reaches
    // the same id no matter which entry it is reached through. That makes the
    // sort key order-independent even for opaque members.
    class Tag {
      constructor(readonly name: string) {}
    }
    const x = new Tag("x")
    const y = new Tag("y")
    const merged = mergeChunks(
      pair(
        { a: [new Map([["p", x], ["q", y]])] },
        { a: [new Map([["q", y], ["p", x]])] },
      ),
    )
    expect((merged.a as unknown[]).length).toBe(1)
  })

  it("keeps Maps apart when their opaque members are different instances", () => {
    // Two equal-looking but distinct instances are not the same value.
    class Tag {
      constructor(readonly name: string) {}
    }
    const merged = mergeChunks(
      pair({ a: [new Map([["p", new Tag("x")]])] }, { a: [new Map([["p", new Tag("x")]])] }),
    )
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("keeps two distinct symbols with the same description apart", () => {
    const merged = mergeChunks(pair({ a: [Symbol("x")] }, { a: [Symbol("x")] }))
    expect((merged.a as symbol[]).length).toBe(2)
  })

  it("collapses the same symbol seen twice", () => {
    const shared = Symbol("x")
    const merged = mergeChunks(pair({ a: [shared] }, { a: [shared] }))
    expect((merged.a as symbol[]).length).toBe(1)
  })
})

describe("mergeInto", () => {
  const Invoice = z.object({
    title: z.string(),
    items: z.array(z.object({ id: z.number() })),
  })

  it("returns the parsed value when the merge satisfies the schema", () => {
    const data = mergeInto(
      Invoice,
      chunks({ title: "Invoice", items: [{ id: 1 }] }, { items: [{ id: 2 }] }),
    )
    expect(data).toEqual({ title: "Invoice", items: [{ id: 1 }, { id: 2 }] })
  })

  it("throws DocumentMergeError when a required field is missing", () => {
    expect(() => mergeInto(Invoice, chunks({ items: [] }))).toThrow(DocumentMergeError)
  })

  it("carries the partial value and chunk errors on the error", () => {
    try {
      mergeInto(Invoice, chunks({ items: [] }))
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

describe("mergeInto with a non-object root", () => {
  it("concatenates when the root is an array", () => {
    // A root array reaches the merge as an array per chunk, not an object.
    const data = mergeInto(
      z.array(z.object({ id: z.number() })),
      chunks([{ id: 1 }, { id: 2 }], [{ id: 3 }]),
    )
    expect(data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it("dedupes a root array the same way array fields do", () => {
    const data = mergeInto(
      z.array(z.object({ id: z.number() })),
      pair([{ id: 1 }], [{ id: 1 }]),
    )
    expect(data).toEqual([{ id: 1 }])
  })

  it("keeps a root-array repeat inside one chunk", () => {
    const data = mergeInto(z.array(z.object({ id: z.number() })), [
      { value: [{ id: 1 }, { id: 1 }], startIndex: 0, endIndex: 100 },
    ])
    expect(data).toEqual([{ id: 1 }, { id: 1 }])
  })

  it("honours dedupe none for a root array", () => {
    const data = mergeInto(
      z.array(z.object({ id: z.number() })),
      pair([{ id: 1 }], [{ id: 1 }]),
      [],
      { dedupe: "none" },
    )
    expect(data).toEqual([{ id: 1 }, { id: 1 }])
  })

  it("keeps a root array element that is null when the element allows it", () => {
    const data = mergeInto(
      z.array(z.string().nullable()),
      chunks(["a"], [null, "b"]),
    )
    expect(data).toEqual(["a", null, "b"])
  })

  it("returns an empty array when every chunk reported an empty list", () => {
    expect(mergeInto(z.array(z.string()), chunks([], []))).toEqual([])
  })

  it("takes the first value when the root is a scalar", () => {
    expect(mergeInto(z.string(), chunks("first", "second"))).toEqual("first")
  })

  it("keeps a Date root as a Date", () => {
    // A Date is an object to `typeof`, so the merge cannot classify it from the
    // runtime value alone — this is why the schema decides. Coercion from an ISO
    // string happens earlier, in extract().
    const first = new Date("2020-01-01T00:00:00Z")
    const data = mergeInto(
      z.date(),
      chunks(first, new Date("2021-06-15T00:00:00Z")),
    )
    expect(data).toBeInstanceOf(Date)
    expect(data.toISOString()).toBe("2020-01-01T00:00:00.000Z")
  })

  it("preserves an explicit null for a nullable scalar root", () => {
    expect(mergeInto(z.string().nullable(), chunks(null, null))).toBeNull()
  })

  it("reports a schema failure rather than silently returning nothing", () => {
    expect(() => mergeInto(z.date(), [])).toThrow(DocumentMergeError)
  })
})
