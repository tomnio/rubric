import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  JsonParseError,
  OutputTruncatedError,
  RetryExhaustedError,
  wrap,
  type AttemptMeta,
  type LLMClient,
  type RequestKwargs,
} from "../src/index.js"
import { truncationReason } from "../src/truncation.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

const messages = [{ role: "user" as const, content: "John is 25" }]

/** An OpenAI tool-call response whose arguments were cut mid-string. */
function truncatedToolResponse(extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [
      {
        finish_reason: "length",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "extract",
                // Cut off inside the string: JSON.parse cannot recover it.
                arguments: '{"name": "Jo',
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
    ...extra,
  }
}

/** A client that always returns the same raw response and counts calls. */
function staticClient(raw: unknown): {
  client: LLMClient
  calls: () => number
  sent: RequestKwargs[]
} {
  const sent: RequestKwargs[] = []
  return {
    client: {
      async chatCompletionsCreate(kwargs) {
        sent.push(kwargs)
        return raw
      },
    },
    calls: () => sent.length,
    sent,
  }
}

describe("truncationReason", () => {
  it("reads the OpenAI finish_reason", () => {
    expect(truncationReason({ choices: [{ finish_reason: "length" }] })).toBe(
      "length",
    )
  })

  it("reads the Anthropic stop_reason", () => {
    expect(truncationReason({ stop_reason: "max_tokens" })).toBe("max_tokens")
  })

  it("reads the Gemini finishReason", () => {
    expect(
      truncationReason({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
    ).toBe("MAX_TOKENS")
  })

  it("accepts max_tokens in the OpenAI slot for compatible gateways", () => {
    expect(
      truncationReason({ choices: [{ finish_reason: "max_tokens" }] }),
    ).toBe("max_tokens")
  })

  it("returns undefined for a normal stop", () => {
    expect(truncationReason({ choices: [{ finish_reason: "stop" }] })).toBeUndefined()
    expect(truncationReason({ stop_reason: "end_turn" })).toBeUndefined()
    expect(truncationReason({ candidates: [{ finishReason: "STOP" }] })).toBeUndefined()
  })

  it("returns undefined for shapes that carry no marker", () => {
    expect(truncationReason({ choices: [{ message: {} }] })).toBeUndefined()
    expect(truncationReason(null)).toBeUndefined()
    expect(truncationReason("nope")).toBeUndefined()
    expect(truncationReason({})).toBeUndefined()
  })
})

describe("create() truncation detection", () => {
  it("throws OutputTruncatedError instead of reasking", async () => {
    const { client, calls } = staticClient(truncatedToolResponse())
    await expect(
      wrap(client).create({
        model: "m",
        schema: User,
        messages,
        // Even with retries available, a cut-off answer is not retried: the
        // same max_tokens would be cut in the same place.
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(OutputTruncatedError)
    expect(calls()).toBe(1)
  })

  it("does not append a reask message before giving up", async () => {
    const { client, sent } = staticClient(truncatedToolResponse())
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: 3 }),
    ).rejects.toThrow(/token limit/)
    // One request, and it still holds only the original user message: no
    // assistant turn and no "fix the JSON" follow-up were sent.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.messages).toHaveLength(1)
  })

  it("carries the marker, the raw response, and the usage spent", async () => {
    const { client } = staticClient(truncatedToolResponse())
    try {
      await wrap(client).create({ model: "m", schema: User, messages })
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(OutputTruncatedError)
      const truncated = error as OutputTruncatedError
      expect(truncated.reason).toBe("length")
      expect(truncated.attempts).toBe(1)
      expect(truncated.raw).toBeDefined()
      expect(truncated.usage?.totalTokens).toBe(14)
      // The underlying JSON failure is preserved, not swallowed.
      expect(truncated.cause).toBeInstanceOf(JsonParseError)
    }
  })

  it("still fires onParseError and onUsage before throwing", async () => {
    const seen: { parse: AttemptMeta[]; usage: AttemptMeta[] } = {
      parse: [],
      usage: [],
    }
    const { client } = staticClient(truncatedToolResponse())
    await expect(
      wrap(client, {
        hooks: {
          onParseError(_error, meta) {
            seen.parse.push(meta)
          },
          onUsage(_usage, meta) {
            seen.usage.push(meta)
          },
        },
      }).create({ model: "m", schema: User, messages, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(OutputTruncatedError)

    expect(seen.parse).toHaveLength(1)
    expect(seen.parse[0]?.isLastAttempt).toBe(true)
    expect(seen.parse[0]?.maxAttempts).toBe(3)
    expect(seen.usage.at(-1)?.isLastAttempt).toBe(true)
  })

  it("returns a truncated response that still validated", async () => {
    // The marker says "the model was stopped", not "the answer is unusable".
    // A complete tool call that arrived before the cap is a good answer.
    const { client } = staticClient({
      choices: [
        {
          finish_reason: "length",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "extract",
                  arguments: JSON.stringify({ name: "John", age: 25 }),
                },
              },
            ],
          },
        },
      ],
    })
    await expect(
      wrap(client).create({ model: "m", schema: User, messages }),
    ).resolves.toEqual({ name: "John", age: 25 })
  })

  it("does not mistake a normal stop for truncation", async () => {
    const { client, calls } = staticClient({
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "extract", arguments: '{"name": "Jo' },
              },
            ],
          },
        },
      ],
    })
    // A genuinely malformed answer is still retried the old way.
    await expect(
      wrap(client).create({ model: "m", schema: User, messages, maxRetries: 1 }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(calls()).toBe(2)
  })

  it("detects truncation in ANTHROPIC_TOOLS", async () => {
    const { client, calls } = staticClient({
      stop_reason: "max_tokens",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "extract",
          input: '{"name": "Jo',
        },
      ],
    })
    await expect(
      wrap(client).create({
        model: "m",
        schema: User,
        messages,
        mode: "ANTHROPIC_TOOLS",
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(OutputTruncatedError)
    expect(calls()).toBe(1)
  })

  it("detects truncation in GEMINI_JSON", async () => {
    const { client, calls } = staticClient({
      candidates: [
        { finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"name": "Jo' }] } },
      ],
    })
    await expect(
      wrap(client).create({
        model: "m",
        schema: User,
        messages,
        mode: "GEMINI_JSON",
        maxRetries: 3,
      }),
    ).rejects.toBeInstanceOf(OutputTruncatedError)
    expect(calls()).toBe(1)
  })

  it("names max_tokens in the message, not the JSON", async () => {
    const { client } = staticClient(truncatedToolResponse())
    await expect(
      wrap(client).create({ model: "m", schema: User, messages }),
    ).rejects.toThrow(/max_tokens/)
  })
})

describe("streaming truncation detection", () => {
  function streamClient(chunks: unknown[]): LLMClient {
    return {
      async chatCompletionsCreate() {
        throw new Error("create should not be called")
      },
      async *chatCompletionsStream() {
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
    for await (const _item of iterable) {
      // Exhaust the stream so the final check runs.
    }
  }

  it("reports a truncated createPartial with no JSON as truncation", async () => {
    const client = wrap(
      streamClient([
        // The model was cut off while still writing prose, before it ever
        // opened a JSON object.
        { choices: [{ delta: { content: "Sure, here is the answer:" } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    )
    await expect(
      drain(client.createPartial({ model: "m", schema: User, messages })),
    ).rejects.toBeInstanceOf(OutputTruncatedError)
  })

  it("still reports a non-truncated empty stream as a JSON error", async () => {
    const client = wrap(
      streamClient([{ choices: [{ delta: { content: "no json here" } }] }]),
    )
    await expect(
      drain(client.createPartial({ model: "m", schema: User, messages })),
    ).rejects.toBeInstanceOf(JsonParseError)
  })

  it("reports a truncated createIterable with no items as truncation", async () => {
    const client = wrap(
      streamClient([
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '[{"name": "Jo' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    )
    await expect(
      drain(client.createIterable({ model: "m", schema: User, messages })),
    ).rejects.toBeInstanceOf(OutputTruncatedError)
  })

  it("does not throw when a truncated stream still yielded a snapshot", async () => {
    const client = wrap(
      streamClient([
        { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"name": "John"' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "length" }] },
      ]),
    )
    const snapshots: unknown[] = []
    for await (const snap of client.createPartial({
      model: "m",
      schema: User,
      messages,
    })) {
      snapshots.push(snap)
    }
    expect(snapshots.length).toBeGreaterThan(0)
  })
})
