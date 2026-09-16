import { describe, expect, it } from "vitest"
import { z } from "zod"
import { wrap, type LLMClient, type RequestKwargs } from "../src/index.js"
import { createDocument, DocumentInterruptedError, type Chunker } from "../src/document/index.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const messages = [{ role: "user" as const, content: "John is 25" }]

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

/** Wait without holding the event loop open past the test. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("timeout validation", () => {
  it("rejects a negative timeout before any call", async () => {
    let calls = 0
    const client = wrap({
      async chatCompletionsCreate() {
        calls += 1
        return toolResponse({ name: "John", age: 25 })
      },
    })
    await expect(
      client.create({ model: "m", schema: User, messages, timeout: -1 }),
    ).rejects.toBeInstanceOf(RangeError)
    expect(calls).toBe(0)
  })

  it("rejects zero", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        return toolResponse({ name: "John", age: 25 })
      },
    })
    await expect(
      client.create({ model: "m", schema: User, messages, timeout: 0 }),
    ).rejects.toThrow(/greater than zero/)
  })

  it("rejects a fractional timeout", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        return toolResponse({ name: "John", age: 25 })
      },
    })
    await expect(
      client.create({ model: "m", schema: User, messages, timeout: 0.5 }),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it("rejects a timeout past the 32-bit limit instead of firing after 1ms", async () => {
    // AbortSignal.timeout(2 ** 31) does not throw: it warns on stderr and fires
    // after 1 ms. Left unchecked, a large timeout would abort every call
    // instantly — the opposite of what the caller wrote.
    const client = wrap({
      async chatCompletionsCreate() {
        return toolResponse({ name: "John", age: 25 })
      },
    })
    await expect(
      client.create({
        model: "m",
        schema: User,
        messages,
        timeout: 2 ** 31,
      }),
    ).rejects.toBeInstanceOf(RangeError)
  })

  it("accepts the largest value AbortSignal.timeout handles", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        return toolResponse({ name: "John", age: 25 })
      },
    })
    await expect(
      client.create({
        model: "m",
        schema: User,
        messages,
        timeout: 2 ** 31 - 1,
      }),
    ).resolves.toEqual({ name: "John", age: 25 })
  })
})

describe("create() timeout", () => {
  it("aborts an in-flight request and reports a TimeoutError", async () => {
    const client = wrap({
      chatCompletionsCreate(_kwargs: RequestKwargs, options?: { signal?: AbortSignal }) {
        // Never resolves on its own; only the signal can end it.
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          )
        })
      },
    })

    await expect(
      client.create({ model: "m", schema: User, messages, timeout: 20 }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it("is one budget for the whole call, not one per attempt", async () => {
    // Each attempt answers only after 30 ms. A per-attempt budget of 50 ms
    // would let all four attempts run (120 ms); a whole-call budget stops the
    // run at ~50 ms, so at most two attempts can start.
    let calls = 0
    const client = wrap({
      async chatCompletionsCreate() {
        calls += 1
        await sleep(30)
        // Valid JSON, wrong shape: forces a retry each time.
        return toolResponse({ name: 1 })
      },
    })

    const started = Date.now()
    await expect(
      client.create({ model: "m", schema: User, messages, maxRetries: 3, timeout: 50 }),
    ).rejects.toThrow()
    const elapsed = Date.now() - started

    expect(calls).toBeLessThan(4)
    expect(elapsed).toBeLessThan(110)
  })

  it("lets a fast call finish well inside the budget", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        return toolResponse({ name: "John", age: 25 })
      },
    })
    await expect(
      client.create({ model: "m", schema: User, messages, timeout: 5_000 }),
    ).resolves.toEqual({ name: "John", age: 25 })
  })

  it("takes the wrap-level default and lets a call override it", async () => {
    const client = wrap(
      {
        async chatCompletionsCreate() {
          return toolResponse({ name: "John", age: 25 })
        },
      },
      { timeout: 5_000 },
    )
    await expect(
      client.create({ model: "m", schema: User, messages }),
    ).resolves.toEqual({ name: "John", age: 25 })
    // A per-call value replaces the default rather than nesting inside it.
    await expect(
      client.create({ model: "m", schema: User, messages, timeout: 5_000 }),
    ).resolves.toEqual({ name: "John", age: 25 })
  })

  it("combines with a caller signal, and the first to fire wins", async () => {
    const controller = new AbortController()
    const client = wrap({
      chatCompletionsCreate(_kwargs: RequestKwargs, options?: { signal?: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(options.signal?.reason),
          )
        })
      },
    })

    const pending = client.create({
      model: "m",
      schema: User,
      messages,
      signal: controller.signal,
      // Long enough that the caller's abort is what ends the call.
      timeout: 5_000,
    })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("rejects timeout on createPartial and createIterable", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        throw new Error("unused")
      },
      async *chatCompletionsStream() {
        yield { choices: [{ delta: { content: '{"name":"John","age":25}' } }] }
      },
    })

    const partial = async () => {
      for await (const _snapshot of client.createPartial({
        model: "m",
        schema: User,
        messages,
        timeout: 100,
      })) {
        // no-op
      }
    }
    const iterable = async () => {
      for await (const _item of client.createIterable({
        model: "m",
        schema: User,
        messages,
        timeout: 100,
      })) {
        // no-op
      }
    }
    await expect(partial()).rejects.toThrow(/not supported by createPartial/)
    await expect(iterable()).rejects.toThrow(/not supported by createIterable/)
  })

  it("still rejects a bad timeout on a streaming call, not just ignores it", async () => {
    const client = wrap({
      async chatCompletionsCreate() {
        throw new Error("unused")
      },
      async *chatCompletionsStream() {
        yield { choices: [{ delta: { content: '{"name":"John","age":25}' } }] }
      },
    })
    const partial = async () => {
      for await (const _snapshot of client.createPartial({
        model: "m",
        schema: User,
        messages,
        timeout: -1,
      })) {
        // no-op
      }
    }
    // Validation runs first, so the message names the bad value rather than
    // claiming streaming is unsupported.
    await expect(partial()).rejects.toThrow(/greater than zero/)
  })
})

describe("createDocument() timeout", () => {
  /** One chunk per call, positioned at the start of the document. */
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

  it("spends one budget across every chunk, not one per chunk", async () => {
    // Each chunk's request takes 40 ms. Three chunks at 40 ms each is 120 ms;
    // a whole-document budget of 70 ms must stop the run part-way, so not all
    // three can complete.
    let calls = 0
    const client: LLMClient = {
      async chatCompletionsCreate() {
        calls += 1
        await sleep(40)
        return toolResponse({ statement: "grounded" })
      },
    }

    const started = Date.now()
    const error = await createDocument(client, {
      model: "m",
      document: "abcdefghij",
      instruction: "Extract.",
      schema: z.object({ statement: z.string() }),
      chunkSize: 4,
      overlap: 0,
      chunker: fixedChunker(4),
      timeout: 70,
    }).catch((err) => err as DocumentInterruptedError)

    const interrupted = error as DocumentInterruptedError
    expect(interrupted).toBeInstanceOf(DocumentInterruptedError)
    expect(interrupted.reason).toBe("timeout")
    expect((interrupted.cause as Error).name).toBe("TimeoutError")
    const elapsed = Date.now() - started

    expect(calls).toBeLessThan(3)
    expect(elapsed).toBeLessThan(120)
  })

  it("does not turn the document budget into N chunk budgets", async () => {
    // The bug this guards: if `timeout` were passed through to each chunk's
    // create() call, every chunk would get a fresh 60 ms and all three would
    // finish (120 ms total). Sharing one deadline means the run is cut at ~60.
    let calls = 0
    const client: LLMClient = {
      async chatCompletionsCreate() {
        calls += 1
        await sleep(40)
        return toolResponse({ statement: "grounded" })
      },
    }

    const error = await createDocument(client, {
      model: "m",
      document: "abcdefghij",
      instruction: "Extract.",
      schema: z.object({ statement: z.string() }),
      chunkSize: 4,
      overlap: 0,
      chunker: fixedChunker(4),
      timeout: 60,
    }).catch((err) => err as DocumentInterruptedError)

    const interrupted = error as DocumentInterruptedError
    expect(interrupted).toBeInstanceOf(DocumentInterruptedError)
    expect(interrupted.reason).toBe("timeout")

    expect(calls).toBeLessThan(3)
  })

  it("lets a document that fits the budget finish normally", async () => {
    const client: LLMClient = {
      async chatCompletionsCreate() {
        return toolResponse({ statement: "grounded" })
      },
    }
    const result = await createDocument(client, {
      model: "m",
      document: "abcdefghij",
      instruction: "Extract.",
      schema: z.object({ statement: z.string() }),
      chunkSize: 4,
      overlap: 0,
      chunker: fixedChunker(4),
      timeout: 5_000,
    })
    expect(result.data.statement).toBe("grounded")
    expect(result.chunks).toHaveLength(3)
  })

  it("takes the wrap-level timeout too", async () => {
    const client: LLMClient = {
      async chatCompletionsCreate() {
        return toolResponse({ statement: "grounded" })
      },
    }
    // The third argument is the same WrapOptions wrap() takes, so the deadline
    // can be set once for every document instead of per call.
    const result = await createDocument(
      client,
      {
        model: "m",
        document: "abcdefghij",
        instruction: "Extract.",
        schema: z.object({ statement: z.string() }),
        chunkSize: 4,
        overlap: 0,
        chunker: fixedChunker(4),
      },
      { timeout: 5_000 },
    )
    expect(result.data.statement).toBe("grounded")
  })

  it("shares one deadline with the chunks rather than one timer each", async () => {
    // The deadline lives on the shared signal, so a `timeout` left in the
    // `defaults` handed to each chunk would make create() build a *second*
    // timer per chunk — N pointless timers on a long document. Behaviour is
    // unchanged (the shared deadline starts earlier and always fires first),
    // so this asserts the mechanism: every chunk gets the same signal object,
    // and it is not the caller's own.
    const seen: AbortSignal[] = []
    const caller = new AbortController()
    const client: LLMClient = {
      async chatCompletionsCreate(_kwargs, options) {
        if (options?.signal) {
          seen.push(options.signal)
        }
        return toolResponse({ statement: "grounded" })
      },
    }

    await createDocument(
      client,
      {
        model: "m",
        document: "abcdefghij",
        instruction: "Extract.",
        schema: z.object({ statement: z.string() }),
        chunkSize: 4,
        overlap: 0,
        chunker: fixedChunker(4),
        signal: caller.signal,
        timeout: 5_000,
      },
    )

    expect(seen).toHaveLength(3)
    // One combined signal, reused for every chunk: same object each time.
    expect(new Set(seen).size).toBe(1)
    // And it is the combined signal, not the caller's raw one.
    expect(seen[0]).not.toBe(caller.signal)
  })
})
