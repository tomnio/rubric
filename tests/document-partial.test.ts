import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  createDocument,
  DocumentInterruptedError,
  type Chunker,
  type ChunkOutcome,
} from "../src/document/index.js"
import {
  TokenBudgetExceeded,
  TokenUsageUnavailableError,
  type LLMClient,
} from "../src/index.js"

const Statement = z.object({ statement: z.string() })
const List = z.object({ items: z.array(z.string()) })

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

/** A tool-call response carrying the given usage, if any. */
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

const COSTLY = { prompt_tokens: 60, completion_tokens: 40 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The chunk text from a request message: the tail after the instruction block. */
function chunkText(content: string): string {
  const marker = "\n\n---\n\n"
  const at = content.indexOf(marker)
  return at >= 0 ? content.slice(at + marker.length) : content
}

describe("createDocument() partial results on interruption", () => {
  it("carries completed chunks on a timeout", async () => {
    // Chunk 0 succeeds quickly, chunk 1 takes longer than the whole-document
    // deadline. The deadline cuts the run with one chunk's worth of paid work.
    const client: LLMClient = {
      async chatCompletionsCreate(kwargs: Record<string, unknown>) {
        const messages = kwargs.messages as Array<{ content: string }>
        if (messages[0]!.content.includes("cd")) {
          // The SDK rejects with a TimeoutError when the deadline signal
          // fires mid-request, rather than hanging forever.
          await sleep(2_000).then(() => {
            const error = new Error("The operation was aborted due to timeout")
            error.name = "TimeoutError"
            throw error
          })
        }
        return toolResponse({ statement: `from: ${chunkText(messages[0]!.content)}` }, COSTLY)
      },
    }

    const error = (await createDocument(client, {
      model: "m",
      document: "abcdef",
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 2,
      overlap: 0,
      chunker: fixedChunker(2),
      timeout: 100,
    }).catch((err) => err)) as DocumentInterruptedError

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect(error.reason).toBe("timeout")
    expect((error.cause as Error).name).toBe("TimeoutError")
    // Exactly chunk 0 completed, and its value survived both on chunks and in
    // the best-effort merge.
    expect(error.chunks).toHaveLength(1)
    expect(error.chunks[0]!.index).toBe(0)
    expect(error.chunks[0]!.value).toEqual({ statement: "from: ab" })
    expect(error.partial).toEqual({ statement: "from: ab" })
    // The spend is accounted for.
    expect(error.usage.totalTokens).toBe(100)
  })

  it("carries completed chunks on a caller abort", async () => {
    // Chunk 0 succeeds, then the caller aborts. Chunk 1 must never start, and
    // chunk 0's value must come back on the error.
    const controller = new AbortController()
    const client: LLMClient = {
      async chatCompletionsCreate(kwargs: Record<string, unknown>) {
        const messages = kwargs.messages as Array<{ content: string }>
        if (messages[0]!.content.includes("cd")) {
          controller.abort()
          // A real SDK rejects the in-flight request once its signal aborts.
          const error = new Error("This operation was aborted")
          error.name = "AbortError"
          throw error
        }
        return toolResponse({ statement: `from: ${chunkText(messages[0]!.content)}` }, COSTLY)
      },
    }

    const error = (await createDocument(client, {
      model: "m",
      document: "abcdef",
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 2,
      overlap: 0,
      chunker: fixedChunker(2),
      signal: controller.signal,
    }).catch((err) => err)) as DocumentInterruptedError

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect(error.reason).toBe("aborted")
    expect((error.cause as Error).name).toBe("AbortError")
    expect(error.chunks).toHaveLength(1)
    expect(error.partial).toEqual({ statement: "from: ab" })
    expect(error.usage.totalTokens).toBe(100)
  })

  it("carries completed chunks when the budget is exhausted", async () => {
    // Chunk 0 spends 100 of a 100-token budget; the check before chunk 1
    // stops the run. Chunk 0's value rides on the error.
    const { client } = answeredClient([{ statement: "grounded" }])

    const error = (await createDocument(client, {
      model: "test-model",
      document: "A".repeat(20),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      tokenBudget: 100,
    }).catch((err) => err)) as DocumentInterruptedError

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect(error.reason).toBe("token-budget")
    expect(error.cause).toBeInstanceOf(TokenBudgetExceeded)
    expect(error.chunks).toHaveLength(1)
    expect(error.partial).toEqual({ statement: "grounded" })
    expect(error.usage.totalTokens).toBe(100)
  })

  it("carries completed chunks when usage is unavailable (fail closed)", async () => {
    // Chunk 0's response omits usage, so the budget cannot be enforced and the
    // run stops. Chunk 0 still succeeded, so its value is not thrown away.
    const { client } = answeredClient([{ statement: "grounded" }], { omitUsage: true })

    const error = (await createDocument(client, {
      model: "test-model",
      document: "A".repeat(20),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      tokenBudget: 10_000,
    }).catch((err) => err)) as DocumentInterruptedError

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect(error.reason).toBe("usage-unavailable")
    expect(error.cause).toBeInstanceOf(TokenUsageUnavailableError)
    expect(error.chunks).toHaveLength(1)
    expect(error.partial).toEqual({ statement: "grounded" })
  })

  it("reports no partial when the interruption lands before any chunk finished", async () => {
    // The caller's signal is already aborted, so no chunk even starts.
    const controller = new AbortController()
    controller.abort()
    const { client, calls } = answeredClient([{ statement: "grounded" }])

    const error = (await createDocument(client, {
      model: "test-model",
      document: "A".repeat(20),
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 10,
      overlap: 0,
      chunker: fixedChunker(10),
      signal: controller.signal,
    }).catch((err) => err)) as DocumentInterruptedError

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect(error.reason).toBe("aborted")
    expect(error.partial).toBeUndefined()
    expect(error.chunks).toHaveLength(0)
    expect(error.usage.totalTokens).toBe(0)
    expect(calls()).toBe(0)
  })

  it("merges array roots by concatenation in the partial", async () => {
    // Two chunks each report items; a timeout then cuts the run. The partial
    // keeps both chunks' items, deduped by the overlap rule (their windows do
    // not overlap here, so all three survive).
    const client: LLMClient = {
      async chatCompletionsCreate(kwargs: Record<string, unknown>) {
        const messages = kwargs.messages as Array<{ content: string }>
        if (messages[0]!.content.includes("ef")) {
          // The SDK rejects with a TimeoutError when the deadline fires.
          await sleep(2_000).then(() => {
            const error = new Error("The operation was aborted due to timeout")
            error.name = "TimeoutError"
            throw error
          })
        }
        const items = messages[0]!.content.includes("cd")
          ? ["b", "c"]
          : ["a"]
        return toolResponse({ items }, COSTLY)
      },
    }

    const error = (await createDocument(client, {
      model: "m",
      document: "abcdef",
      instruction: "Extract.",
      schema: List,
      chunkSize: 2,
      overlap: 0,
      chunker: fixedChunker(2),
      timeout: 150,
    }).catch((err) => err)) as DocumentInterruptedError

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect(error.partial).toEqual({ items: ["a", "b", "c"] })
  })

  it("keeps provenance for skipped failed chunks in the interruption", async () => {
    // Chunk 0 fails and is skipped, chunk 1 succeeds, chunk 2 hits the
    // deadline. The error's chunks must show all three positions: the failure
    // with its error, the success with its value.
    const client: LLMClient = {
      async chatCompletionsCreate(kwargs: Record<string, unknown>) {
        const messages = kwargs.messages as Array<{ content: string }>
        const content = messages[0]!.content
        if (content.includes("ab")) {
          throw new Error("boom")
        }
        if (content.includes("ef")) {
          // The SDK rejects with a TimeoutError when the deadline fires.
          await sleep(2_000).then(() => {
            const error = new Error("The operation was aborted due to timeout")
            error.name = "TimeoutError"
            throw error
          })
        }
        return toolResponse({ statement: `from: ${chunkText(content)}` }, COSTLY)
      },
    }

    const error = (await createDocument(client, {
      model: "m",
      document: "abcdef",
      instruction: "Extract.",
      schema: Statement,
      chunkSize: 2,
      overlap: 0,
      chunker: fixedChunker(2),
      maxRetries: 0,
      timeout: 200,
    }).catch((err) => err)) as DocumentInterruptedError

    expect(error).toBeInstanceOf(DocumentInterruptedError)
    expect(error.chunks).toHaveLength(2)
    const failed = error.chunks[0] as ChunkOutcome
    expect(failed.index).toBe(0)
    expect(failed.value).toBeUndefined()
    expect(failed.error).toBeInstanceOf(Error)
    expect((failed.error as Error).message).toContain("boom")
    const ok = error.chunks[1] as ChunkOutcome
    expect(ok.index).toBe(1)
    expect(ok.value).toEqual({ statement: "from: cd" })
    expect(error.partial).toEqual({ statement: "from: cd" })
  })
})

/**
 * A client that answers each call with the next payload (repeating the last),
 * every response costing COSTLY — or omitting usage when asked.
 */
function answeredClient(
  payloads: unknown[],
  opts?: { omitUsage?: boolean },
): { client: LLMClient; calls: () => number } {
  let index = 0
  return {
    client: {
      async chatCompletionsCreate() {
        const payload = payloads[Math.min(index, payloads.length - 1)]
        index += 1
        return toolResponse(payload, opts?.omitUsage ? undefined : COSTLY)
      },
    },
    calls: () => index,
  }
}
