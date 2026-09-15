import { describe, expect, it } from "vitest"
import { z } from "zod"
import { JsonCompleteness } from "../src/completeness.js"
import { buildSnapshot } from "../src/snapshot.js"
import { jsonSlice, parseIncomplete } from "../src/stream-json.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const Nested = z.object({
  user: z.object({
    name: z.string(),
    age: z.number().int(),
  }),
  tags: z.array(z.string()),
})

/** Run one frame through the same pipeline `createPartial` uses. */
function snapshot(buffer: string, schema: z.ZodTypeAny) {
  const tracker = new JsonCompleteness()
  tracker.analyze(jsonSlice(buffer).trim())
  const json = parseIncomplete(buffer)
  return { built: buildSnapshot(json, schema, tracker), tracker }
}

describe("JsonCompleteness", () => {
  it("marks every path complete for a closed structure", () => {
    const tracker = new JsonCompleteness()
    tracker.analyze('{"name": "Alice", "age": 30}')
    expect(tracker.isRootComplete()).toBe(true)
    expect(tracker.isComplete("name")).toBe(true)
    expect(tracker.isComplete("age")).toBe(true)
  })

  it("trusts a value that has a next sibling", () => {
    const tracker = new JsonCompleteness()
    // `age` has a value, so it survives the partial parse and becomes a real
    // sibling of `name`. `name` must then be finished.
    tracker.analyze('{"name": "Alice", "age": 3')
    expect(tracker.isComplete("name")).toBe(true)
    expect(tracker.isComplete("age")).toBe(false)
    expect(tracker.isRootComplete()).toBe(false)
  })

  it("stays conservative when a trailing key has no value yet", () => {
    // `partial-json` drops an incomplete trailing key, so `name` becomes the
    // last sibling and is not marked complete. That skips validation for one
    // frame — a false negative, never a wrong validation.
    const tracker = new JsonCompleteness()
    tracker.analyze('{"name": "Alice", "age": ')
    expect(tracker.isComplete("name")).toBe(false)
  })

  it("does not trust the last sibling of an open structure", () => {
    const tracker = new JsonCompleteness()
    tracker.analyze('{"name": "Ali')
    expect(tracker.isComplete("name")).toBe(false)
    expect(tracker.isRootComplete()).toBe(false)
  })

  it("uses array indices in paths", () => {
    const tracker = new JsonCompleteness()
    tracker.analyze('{"tags": ["a", "b", "c')
    expect(tracker.isComplete("tags[0]")).toBe(true)
    expect(tracker.isComplete("tags[1]")).toBe(true)
    expect(tracker.isComplete("tags[2]")).toBe(false)
  })

  it("is empty for blank input", () => {
    const tracker = new JsonCompleteness()
    tracker.analyze("   ")
    expect(tracker.getCompletePaths()).toEqual([])
  })
})

describe("completeness-aware snapshots", () => {
  it("keeps a truncated string instead of treating it as final", () => {
    // partial-json would close this to {"name":"Jo"} and it would look done.
    const { built, tracker } = snapshot('{"name": "Jo', User)
    expect(built.ok).toBe(true)
    expect(built.value).toEqual({ name: "Jo" })
    // The path is NOT complete, which is what makes it untrustworthy.
    expect(tracker.isComplete("name")).toBe(false)
  })

  it("validates a field that has fully arrived", () => {
    const { built, tracker } = snapshot('{"name": "John", "age": 2', User)
    expect(built.ok).toBe(true)
    expect(built.value).toEqual({ name: "John", age: 2 })
    expect(tracker.isComplete("name")).toBe(true)
    expect(tracker.isComplete("age")).toBe(false)
  })

  it("drops a closed subtree whose value is invalid", () => {
    // `user` is closed and has a next sibling, so it is validated. age "x" is
    // not an int, so the subtree is dropped rather than shown as data.
    const { built } = snapshot('{"user": {"name": "Alice", "age": "x"}, "tags": [', Nested)
    expect(built.ok).toBe(true)
    expect(built.value).toEqual({ tags: [] })
  })

  it("keeps a closed subtree whose value is valid", () => {
    const { built } = snapshot('{"user": {"name": "Alice", "age": 30}, "tags": [', Nested)
    expect(built.ok).toBe(true)
    expect(built.value).toEqual({ user: { name: "Alice", age: 30 }, tags: [] })
  })

  it("validates a nested subtree while its last sibling is still open", () => {
    const { built } = snapshot(
      '{"user": {"name": "Alice", "age": 30}, "tags": ["a", "b',
      Nested,
    )
    expect(built.ok).toBe(true)
    // user was validated as a whole; the truncated tag stays raw.
    expect(built.value).toEqual({
      user: { name: "Alice", age: 30 },
      tags: ["a", "b"],
    })
  })

  it("drops the whole snapshot when the root is closed but invalid", () => {
    const { built } = snapshot('{"name": "John", "age": "oops"}', User)
    expect(built.ok).toBe(false)
  })

  it("keeps a valid root snapshot", () => {
    const { built } = snapshot('{"name": "John", "age": 25}', User)
    expect(built.ok).toBe(true)
    expect(built.value).toEqual({ name: "John", age: 25 })
  })

  it("keeps unknown keys while the root is still open", () => {
    // Not yet closed, so no validation strips them.
    const { built } = snapshot('{"name": "John", "age": 25, "extra": 1', User)
    expect(built.ok).toBe(true)
    expect(built.value).toMatchObject({ extra: 1 })
  })

  it("lets the schema strip unknown keys once the root closes", () => {
    const { built } = snapshot('{"name": "John", "age": 25, "extra": 1}', User)
    expect(built.ok).toBe(true)
    expect(built.value).toEqual({ name: "John", age: 25 })
  })
})
