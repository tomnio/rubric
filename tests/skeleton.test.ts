import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
  wrap,
} from "../src/index.ts"

describe("skeleton", () => {
  it("exports wrap as a function", () => {
    expect(typeof wrap).toBe("function")
  })

  it("wrap is not implemented yet", () => {
    expect(() => wrap({})).toThrow(/not implemented/)
  })

  it("constructs JsonParseError with the raw payload", () => {
    const err = new JsonParseError("not json", "hello")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("JsonParseError")
    expect(err.raw).toBe("hello")
  })

  it("constructs SchemaValidationError with issues", () => {
    const parsed = z.object({ age: z.number() }).safeParse({ age: "x" })
    expect(parsed.success).toBe(false)
    if (parsed.success) return

    const err = new SchemaValidationError("invalid", parsed.error.issues)
    expect(err.name).toBe("SchemaValidationError")
    expect(err.issues).toBe(parsed.error.issues)
  })

  it("constructs RetryExhaustedError with attempt count", () => {
    const last = new JsonParseError("not json", null)
    const err = new RetryExhaustedError("gave up", 4, last)
    expect(err.name).toBe("RetryExhaustedError")
    expect(err.attempts).toBe(4)
    expect(err.lastError).toBe(last)
  })
})
