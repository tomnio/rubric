import { describe, expect, it } from "vitest"
import Anthropic from "@anthropic-ai/sdk"
import { GoogleGenAI } from "@google/genai"
import OpenAI from "openai"
import { z } from "zod"
import { cited, wrap } from "../src/index.js"

/**
 * Compile-time contracts. These tests assert almost nothing at runtime — their
 * value is that they must *typecheck*. They exist because two defects slipped
 * through for a long time with every runtime test green:
 *
 *   - `wrap(new OpenAI())` did not typecheck, because the duck-typed client
 *     declared `create` as a function-typed property (contravariant parameters)
 *     while the real SDK takes a specific request type. Every README example
 *     and every `examples/*.ts` was therefore a type error that nothing caught,
 *     since neither was in `tsconfig.include`.
 *   - `cited()`'s `z.infer` degraded to `unknown`, so callers had to cast the
 *     result of `create()` to read `substring_quotes`. The citation tests hid
 *     it because `expect()` accepts `unknown`.
 *
 * Each `it` fails to compile if the contract regresses. `expectTypeOf` is not
 * used (no runtime assertion needed); assigning to a typed local is enough.
 */
describe("type contracts", () => {
  it("accepts a real OpenAI SDK instance", () => {
    const client = wrap(new OpenAI({ apiKey: "test" }))
    expect(typeof client.create).toBe("function")
  })

  it("accepts a real Anthropic SDK instance", () => {
    const client = wrap(new Anthropic({ apiKey: "test" }))
    expect(typeof client.create).toBe("function")
  })

  it("accepts a real Google GenAI SDK instance", () => {
    const client = wrap(new GoogleGenAI({ apiKey: "test" }))
    expect(typeof client.create).toBe("function")
  })

  it("types the create() result of a cited() schema", async () => {
    const Fact = cited(z.object({ statement: z.string() }))
    const client = wrap({
      async chatCompletionsCreate() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  statement: "a",
                  substring_quotes: ["b"],
                }),
              },
            },
          ],
        }
      },
    })
    const result = await client.create({
      model: "test-model",
      schema: Fact,
      messages: [],
      mode: "MD_JSON",
    })
    // The contract: this needs no cast. `substring_quotes` is string[].
    const quotes: string[] = result.substring_quotes
    const statement: string = result.statement
    expect(quotes).toEqual(["b"])
    expect(statement).toBe("a")
  })
})
