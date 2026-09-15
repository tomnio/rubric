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

describe("mergeChunks dedupe key", () => {
  it("keeps distinct Date values apart", () => {
    const merged = mergeChunks([
      {
        events: [
          new Date("2020-01-01T00:00:00Z"),
          new Date("2021-06-15T00:00:00Z"),
          new Date("2023-12-31T00:00:00Z"),
        ],
      },
    ])
    expect((merged.events as Date[]).length).toBe(3)
  })

  it("still collapses two Dates that hold the same instant", () => {
    const merged = mergeChunks([
      { events: [new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z")] },
    ])
    expect((merged.events as Date[]).length).toBe(1)
  })

  it("distinguishes an invalid Date from a valid one and from another invalid one", () => {
    const merged = mergeChunks([{ events: [new Date("nope"), new Date("nope"), new Date()] }])
    expect((merged.events as Date[]).length).toBe(2)
  })

  it("keeps distinct Map values apart", () => {
    const merged = mergeChunks([{ a: [new Map([["k", 1]]), new Map([["k", 2]])] }])
    expect((merged.a as Map<string, number>[]).length).toBe(2)
  })

  it("collapses two Maps with the same entries regardless of insertion order", () => {
    const merged = mergeChunks([
      {
        a: [
          new Map<string, number>([["x", 1], ["y", 2]]),
          new Map<string, number>([["y", 2], ["x", 1]]),
        ],
      },
    ])
    expect((merged.a as Map<string, number>[]).length).toBe(1)
  })

  it("keeps distinct Set values apart", () => {
    const merged = mergeChunks([{ a: [new Set([1]), new Set([2])] }])
    expect((merged.a as Set<number>[]).length).toBe(2)
  })

  it("collapses two Sets with the same members regardless of insertion order", () => {
    const merged = mergeChunks([{ a: [new Set([1, 2]), new Set([2, 1])] }])
    expect((merged.a as Set<number>[]).length).toBe(1)
  })

  it("keeps distinct RegExp values apart", () => {
    const merged = mergeChunks([{ a: [/a/, /b/] }])
    expect((merged.a as RegExp[]).length).toBe(2)
  })

  it("distinguishes two RegExps that differ only in flags", () => {
    const merged = mergeChunks([{ a: [/a/g, /a/i] }])
    expect((merged.a as RegExp[]).length).toBe(2)
  })

  it("does not collide NaN with null", () => {
    const merged = mergeChunks([{ a: [NaN, null] }])
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("collapses two NaNs", () => {
    const merged = mergeChunks([{ a: [NaN, NaN] }])
    expect((merged.a as unknown[]).length).toBe(1)
  })

  it("distinguishes NaN, Infinity, -Infinity and null from one another", () => {
    const merged = mergeChunks([{ a: [NaN, Infinity, -Infinity, null] }])
    expect((merged.a as unknown[]).length).toBe(4)
  })

  it("distinguishes -0 from 0", () => {
    const merged = mergeChunks([{ a: [-0, 0] }])
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("keeps distinct nested Dates apart", () => {
    // The issue's nested case: canonicalize recursed, so every row's `d`
    // became "{}" and the second row was dropped.
    const merged = mergeChunks([
      {
        rows: [
          { d: new Date("2020-01-01T00:00:00Z"), n: "a" },
          { d: new Date("2021-01-01T00:00:00Z"), n: "a" },
        ],
      },
    ])
    expect((merged.rows as unknown[]).length).toBe(2)
  })

  it("treats a class instance as opaque: distinct instances stay distinct", () => {
    class Money {
      constructor(readonly amount: number) {}
    }
    const merged = mergeChunks([{ a: [new Money(1), new Money(2)] }])
    expect((merged.a as Money[]).length).toBe(2)
  })

  it("treats the same class instance as equal to itself", () => {
    class Money {
      constructor(readonly amount: number) {}
    }
    const one = new Money(1)
    const merged = mergeChunks([{ a: [one, one] }])
    expect((merged.a as Money[]).length).toBe(1)
  })

  it("does not let a string payload imitate the key encoding", () => {
    // Length-prefixing keeps the encoding injective: a string that looks like a
    // key for another value must not collide with that value's own key.
    const merged = mergeChunks([{ a: ["array:[]", []] }])
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("does not confuse a nested array with a nested object", () => {
    const merged = mergeChunks([{ a: [[1], { 0: 1 }] }])
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("distinguishes an object key from a string value", () => {
    const merged = mergeChunks([{ a: [{ k: "v" }, { k: "v" }] }])
    expect((merged.a as unknown[]).length).toBe(1)
  })

  it("collapses Maps whose opaque members were inserted in a different order", () => {
    // The identity table is shared across the whole dedupe() call, so a member
    // reaches the same id no matter which entry it is reached through. That
    // makes the sort key order-independent even for opaque members.
    class Tag {
      constructor(readonly name: string) {}
    }
    const x = new Tag("x")
    const y = new Tag("y")
    const merged = mergeChunks([
      { a: [new Map([["p", x], ["q", y]]), new Map([["q", y], ["p", x]])] },
    ])
    expect((merged.a as unknown[]).length).toBe(1)
  })

  it("keeps Maps apart when their opaque members are different instances", () => {
    // Two equal-looking but distinct instances are not the same value.
    class Tag {
      constructor(readonly name: string) {}
    }
    const merged = mergeChunks([
      { a: [new Map([["p", new Tag("x")]]), new Map([["p", new Tag("x")]])] },
    ])
    expect((merged.a as unknown[]).length).toBe(2)
  })

  it("keeps two distinct symbols with the same description apart", () => {
    const merged = mergeChunks([{ a: [Symbol("x"), Symbol("x")] }])
    expect((merged.a as symbol[]).length).toBe(2)
  })

  it("collapses the same symbol seen twice", () => {
    const shared = Symbol("x")
    const merged = mergeChunks([{ a: [shared, shared] }])
    expect((merged.a as symbol[]).length).toBe(1)
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

describe("mergeInto with a non-object root", () => {
  it("concatenates when the root is an array", () => {
    // A root array reaches the merge as an array per chunk, not an object.
    const data = mergeInto(z.array(z.object({ id: z.number() })), [
      [{ id: 1 }, { id: 2 }],
      [{ id: 3 }],
    ])
    expect(data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it("dedupes a root array the same way array fields do", () => {
    const data = mergeInto(z.array(z.object({ id: z.number() })), [
      [{ id: 1 }],
      [{ id: 1 }],
    ])
    expect(data).toEqual([{ id: 1 }])
  })

  it("keeps a root array element that is null when the element allows it", () => {
    const data = mergeInto(z.array(z.string().nullable()), [["a"], [null, "b"]])
    expect(data).toEqual(["a", null, "b"])
  })

  it("returns an empty array when every chunk reported an empty list", () => {
    expect(mergeInto(z.array(z.string()), [[], []])).toEqual([])
  })

  it("takes the first value when the root is a scalar", () => {
    expect(mergeInto(z.string(), ["first", "second"])).toEqual("first")
  })

  it("keeps a Date root as a Date", () => {
    // A Date is an object to `typeof`, so the merge cannot classify it from the
    // runtime value alone — this is why the schema decides. Coercion from an ISO
    // string happens earlier, in extract().
    const first = new Date("2020-01-01T00:00:00Z")
    const data = mergeInto(z.date(), [first, new Date("2021-06-15T00:00:00Z")])
    expect(data).toBeInstanceOf(Date)
    expect(data.toISOString()).toBe("2020-01-01T00:00:00.000Z")
  })

  it("preserves an explicit null for a nullable scalar root", () => {
    expect(mergeInto(z.string().nullable(), [null, null])).toBeNull()
  })

  it("reports a schema failure rather than silently returning nothing", () => {
    expect(() => mergeInto(z.date(), [])).toThrow(DocumentMergeError)
  })
})
