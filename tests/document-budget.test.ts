import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createDocument,
  DocumentChunkError,
  DocumentInterruptedError,
  DocumentNoDataError,
  type Chunker,
} from "../src/document/index.js"
import {
  TokenBudgetExceeded,
  TokenUsageUnavailableError,
  type LLMClient,
  type WrapOptions,
} from "../src/index.js"

const Statement = z.object({ statement: z.string() })

/** One chunk per `size` characters, no overlap. */
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

/** A tool-call response that reports the given usage. */
function toolResponse(
  payload: unknown,
  usage?: { prompt_tokens: number; completion_tokens: number },
): unknown {
  return {
    usage,
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "extract",
                arguments:
                  typeof payload === "string" ? payload : JSON.stringify(payload),
              },
            },
          ],
        },
      },
    ],
  }
}

/** 100 tokens per call, so the document total moves 100 at a time. */
const COSTLY = { prompt_tokens: 60, completion_tokens: 40 }

type Answer = [unknown, { prompt_tokens: number; completion_tokens: number } | undefined]

/**
 * Answer the nth provider call with the nth entry, repeating the last. Each
 * entry is `[payload, usage]`, so a reask can cost a different amount.
 */
function sequenceClient(answers: Answer[]): {
  client: LLMClient
  calls: () => number
} {
  let index = 0
  return {
    client: {
      async chatCompletionsCreate() {
        const next = answers[Math.min(index, answers.length - 1)]!
        index += 1
        return toolResponse(next[0], next[1])
      },
    },
    calls: () => index,
  }
}

/**
 * Run a document of `chunkCount` chunks. Each chunk is `size` characters, and
 * the document is sized so the chunk count is exact.
 */
function run(
  client: LLMClient,
  extra: Record<string, unknown>,
  options?: WrapOptions,
) {
  return createDocument(
    client,
    {
      model: "test-model",
      document: "A".repeat(100),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      ...extra,
    },
    options,
  )
}

describe("createDocument() document-wide tokenBudget", () => {
  it("stops before starting a chunk the budget cannot afford", async () => {
    // 10 chunks at 100 tokens each. A document budget of 100 is spent by the
    // first chunk, so the second never starts.
    const { client, calls } = sequenceClient([[{ statement: "grounded" }, COSTLY]])

    const error = await run(client, { tokenBudget: 100 }).catch((err) => err)

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect((error as DocumentInterruptedError).reason).toBe("token-budget")
    expect((error as DocumentInterruptedError).cause).toBeInstanceOf(
      TokenBudgetExceeded,
    )
    expect(calls()).toBe(1)
  })

  it("names the document scope in the error, not a single chunk", async () => {
    const { client } = sequenceClient([[{ statement: "grounded" }, COSTLY]])

    const error = (await run(client, { tokenBudget: 100 }).catch(
      (err) => err,
    )) as DocumentInterruptedError

    // The document-scope phrasing stays on the cause, where the budget
    // guardrail itself raised it.
    expect((error.cause as TokenBudgetExceeded).message).toMatch(
      /^Document token budget/,
    )
    // The totals on the error are the document's, not one chunk's.
    expect(error.usage.totalTokens).toBe(100)
    expect((error.cause as TokenBudgetExceeded).budget).toBe(100)
  })

  it("returns a document whose final chunk crosses the budget", async () => {
    // The guardrail blocks the next chunk, not the answer in hand: two chunks
    // spend 200 tokens against a budget of 150, but the second was already paid
    // for by the time the total was known, and no chunk follows it.
    const { client, calls } = sequenceClient([[{ statement: "grounded" }, COSTLY]])

    const result = await createDocument(
      client,
      {
        model: "test-model",
        document: "A".repeat(20),
        instruction: "Extract.",
        schema: Statement,
        chunkSize: 10,
        overlap: 0,
        chunker: fixedChunker(10),
        tokenBudget: 150,
      },
    )

    expect(result.data.statement).toBe("grounded")
    expect(calls()).toBe(2)
    expect(result.usage.totalTokens).toBe(200)
  })

  it("does not forward the document budget to each chunk", async () => {
    // The regression this guards: before `tokenBudget` meant "whole document",
    // it was handed to every chunk, so a budget of 50 would abort a chunk that
    // had spent 100 — cutting the reask short. With one chunk there is no
    // second chunk for the document check to fire on, so this isolates the
    // per-chunk path: the reask must still happen.
    const { client, calls } = sequenceClient([
      ["not json", COSTLY],
      [{ statement: "grounded" }, COSTLY],
    ])

    const result = await createDocument(client, {
      model: "test-model",
      document: "A".repeat(10),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      tokenBudget: 50,
    })

    expect(result.data.statement).toBe("grounded")
    expect(calls()).toBe(2)
  })

  it("treats a wrap-level tokenBudget as the document budget, not a chunk cap", async () => {
    // Set once on wrap(), it must mean the same thing as the per-call option —
    // and must not leak into the `defaults` each chunk receives, where it would
    // be applied again per chunk. A single chunk isolates that leak: with the
    // budget on the chunk, the reask after 100 tokens would be cut short.
    const { client, calls } = sequenceClient([
      ["not json", COSTLY],
      [{ statement: "grounded" }, COSTLY],
    ])

    const result = await createDocument(
      client,
      {
        model: "test-model",
        document: "A".repeat(10),
        instruction: "Extract.",
        schema: Statement,
        chunkSize: 10,
        overlap: 0,
        chunker: fixedChunker(10),
      },
      { tokenBudget: 50 },
    )

    expect(result.data.statement).toBe("grounded")
    expect(calls()).toBe(2)
  })

  it("applies a wrap-level budget across chunks", async () => {
    const { client, calls } = sequenceClient([[{ statement: "grounded" }, COSTLY]])

    const error = await run(client, {}, { tokenBudget: 100 }).catch((err) => err)

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect((error as DocumentInterruptedError).reason).toBe("token-budget")
    expect(calls()).toBe(1)
  })

  it("fails closed when a chunk reports no usage", async () => {
    // Without token counts the document total is not the real spend, so the
    // budget cannot be enforced and the call stops rather than continuing
    // blind — the same rule create() applies within one call.
    const { client } = sequenceClient([[{ statement: "grounded" }, undefined]])

    const error = await run(client, { tokenBudget: 10_000 }).catch((err) => err)

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect((error as DocumentInterruptedError).reason).toBe("usage-unavailable")
    expect((error as DocumentInterruptedError).cause).toBeInstanceOf(
      TokenUsageUnavailableError,
    )
  })

  it("does not abort the budget for a chunk that failed to reach the provider", async () => {
    // A network error is not the same as a response that omitted usage: the
    // chunk is already visible as a failure, and `onChunkError: "skip"` is the
    // caller's stated preference. Treating the unknown spend as unaccountable
    // would let one blip abort a budgeted document that would otherwise finish.
    let index = 0
    const client: LLMClient = {
      async chatCompletionsCreate() {
        index += 1
        if (index === 1) {
          throw new Error("ECONNRESET")
        }
        return toolResponse({ statement: "grounded" }, COSTLY)
      },
    }

    const result = await createDocument(client, {
      model: "test-model",
      document: "A".repeat(20),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      tokenBudget: 10_000,
    })

    expect(result.data.statement).toBe("grounded")
    expect(result.chunks[0]?.error).toBeInstanceOf(DocumentChunkError)
    // Chunk 0 threw; chunk 1 succeeded. The document ran to the end.
    expect(index).toBe(2)
  })

  it("rejects a bad budget before any chunk runs", async () => {
    const { client, calls } = sequenceClient([[{ statement: "grounded" }, COSTLY]])

    await expect(run(client, { tokenBudget: 1.5 })).rejects.toThrow(
      /positive integer/,
    )
    await expect(run(client, { tokenBudget: 0 })).rejects.toThrow(
      /greater than zero/,
    )
    expect(calls()).toBe(0)
  })

  it("has no effect when no budget is set", async () => {
    const { client, calls } = sequenceClient([[{ statement: "grounded" }, COSTLY]])

    const result = await run(client, {})

    expect(result.data.statement).toBe("grounded")
    expect(calls()).toBe(10)
  })
})

describe("createDocument() chunkTokenBudget", () => {
  it("caps one chunk and names the chunk scope", async () => {
    // Each chunk is allowed 50 tokens but the first attempt costs 100. The
    // chunk's own guardrail stops its reask, so the chunk fails; `abort` turns
    // that into a DocumentChunkError whose cause is the per-chunk budget error
    // — distinct from the document-scoped one by name.
    const { client, calls } = sequenceClient([
      ["not json", COSTLY],
      [{ statement: "grounded" }, COSTLY],
    ])

    const error = await createDocument(client, {
      model: "test-model",
      document: "A".repeat(10),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      chunkTokenBudget: 50,
      onChunkError: "abort",
    }).catch((err) => err)

    expect(error).toBeInstanceOf(DocumentChunkError)
    const cause = (error as DocumentChunkError).cause
    expect(cause).toBeInstanceOf(TokenBudgetExceeded)
    expect((cause as Error).message).toMatch(/^Token budget/)
    expect(calls()).toBe(1)
  })

  it("is skipped like any other chunk failure by default", async () => {
    // The default `onChunkError: "skip"` records the capped chunk and keeps
    // going, so the other chunks still contribute.
    const { client, calls } = sequenceClient([
      ["not json", COSTLY],
      [{ statement: "grounded" }, { prompt_tokens: 1, completion_tokens: 1 }],
    ])

    const result = await run(client, {
      chunkTokenBudget: 50,
      tokenBudget: 10_000,
    })

    expect(result.data.statement).toBe("grounded")
    // First chunk: one attempt, then capped. Remaining chunks: one attempt each.
    expect(calls()).toBe(10)
    expect(result.chunks[0]?.error).toBeInstanceOf(DocumentChunkError)
  })

  it("is rejected when invalid, before any chunk runs", async () => {
    const { client, calls } = sequenceClient([[{ statement: "grounded" }, COSTLY]])

    await expect(run(client, { chunkTokenBudget: -1 })).rejects.toThrow(
      /greater than zero/,
    )
    await expect(run(client, { chunkTokenBudget: 2.5 })).rejects.toThrow(
      /positive integer/,
    )
    expect(calls()).toBe(0)
  })

  it("lets a chunk under its cap reask normally", async () => {
    const { client, calls } = sequenceClient([
      ["not json", { prompt_tokens: 10, completion_tokens: 5 }],
      [{ statement: "grounded" }, { prompt_tokens: 10, completion_tokens: 5 }],
    ])

    const result = await createDocument(client, {
      model: "test-model",
      document: "A".repeat(10),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      chunkTokenBudget: 1_000,
    })

    expect(result.data.statement).toBe("grounded")
    expect(calls()).toBe(2)
  })

  it("still reports no-data when every chunk is capped", async () => {
    const { client } = sequenceClient([["not json", COSTLY]])

    const error = await run(client, { chunkTokenBudget: 50 }).catch((err) => err)

    expect(error).toBeInstanceOf(DocumentNoDataError)
    expect((error as DocumentNoDataError).chunkErrors).toHaveLength(10)
  })
})
