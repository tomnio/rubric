import { describe, expect, it } from "vitest"
import { z } from "zod"
import { createDocument, defaultChunker } from "../src/document/index.js"
import { cited } from "../src/citation.js"
import type { LLMClient, RequestKwargs } from "../src/index.js"

/**
 * End-to-end through the real Chonkie chunker (WASM). Uses a fake LLM client
 * so no network is involved; skips if the optional dependency is absent.
 */
const hasChonkie = await import("@chonkiejs/core")
  .then(() => true)
  .catch(() => false)

function toolResponse(payload: unknown): unknown {
  return {
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

/** Echo back the quotes found in the chunk, so cited() can verify them. */
function quotingClient(capture: RequestKwargs[] = []): LLMClient {
  return {
    async chatCompletionsCreate(kwargs) {
      capture.push(kwargs)
      const content = String(kwargs.messages[0]?.content ?? "")
      // The instruction and chunk are joined by a "---" separator.
      const chunk = content.split("---\n\n").at(-1) ?? ""
      const firstLine = chunk.split("\n").find((line) => line.trim().length > 0) ?? ""
      return toolResponse({
        statement: "grounded",
        substring_quotes: [firstLine.trim()],
      })
    },
  }
}

const DOC = [
  "The sky is blue today.",
  "",
  "Grass is green in spring.",
  "",
  "Snow is white in winter.",
].join("\n")

describe.skipIf(!hasChonkie)("createDocument with the real chunker", () => {
  it("splits a document and merges one object out of it", async () => {
    const Fact = z.object({ statement: z.string() })
    const result = await createDocument(
      quotingClient(),
      {
        model: "test-model",
        document: DOC,
        instruction: "Extract a fact.",
        schema: Fact,
        chunkSize: 40,
        overlap: 0,
      },
      { mode: "TOOLS" },
    )

    expect(result.chunks.length).toBeGreaterThan(1)
    expect(result.data.statement).toBe("grounded")
    // Provenance points back into the original document.
    for (const outcome of result.chunks) {
      expect(outcome.endIndex).toBeGreaterThan(outcome.startIndex)
      expect(outcome.endIndex).toBeLessThanOrEqual(DOC.length)
    }
  })

  it("verifies cited quotes against the chunk each one came from", async () => {
    const Fact = cited(z.object({ statement: z.string() }))
    const result = await createDocument(
      quotingClient(),
      {
        model: "test-model",
        document: DOC,
        instruction: "Extract a fact.",
        schema: Fact,
        chunkSize: 40,
        overlap: 0,
      },
      { mode: "TOOLS" },
    )

    // Every returned quote is a real span of the document: cited() checked it
    // against the chunk text, which came from the document.
    const quotes = (result.data as { substring_quotes: string[] }).substring_quotes
    expect(quotes.length).toBeGreaterThan(0)
    for (const quote of quotes) {
      expect(DOC).toContain(quote)
    }
  })

  it("rejects a fabricated quote, proving the chunk reaches cited()", async () => {
    // Without a context, cited() passes every quote through unchecked, so this
    // only fails when createDocument() actually forwards the chunk text.
    const Fabricating = cited(z.object({ statement: z.string() }))
    const fabricating: LLMClient = {
      async chatCompletionsCreate() {
        return toolResponse({
          statement: "grounded",
          substring_quotes: ["the sky is plaid"],
        })
      },
    }

    await expect(
      createDocument(
        fabricating,
        {
          model: "test-model",
          document: DOC,
          instruction: "Extract a fact.",
          schema: Fabricating,
          chunkSize: 40,
          overlap: 0,
          maxRetries: 0,
        },
        { mode: "TOOLS" },
      ),
    ).rejects.toThrow()
  })
})

describe("defaultChunker", () => {
  it.skipIf(!hasChonkie)("is exported for direct use", async () => {
    const chunks = await defaultChunker(DOC, { chunkSize: 40 })
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(DOC)
  })
})
