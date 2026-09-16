import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { fromProvider } from "../src/from-provider.js"
import { compatible } from "../src/index.js"
import type { RequestKwargs } from "../src/types.js"

// The SDKs are loaded with dynamic import() inside fromProvider, so vi.mock
// intercepts them. Each mock records its constructor args; the returned
// client is a minimal OpenAI-shaped fake that also records the kwargs it
// receives, so tests can assert the routed mode without touching a network.
const constructed: Array<{ sdk: string; args: unknown[] }> = []
const requestKwargs: RequestKwargs[] = []

// Text-mode responses (MD_JSON / GEMINI_JSON) carry the payload as plain JSON
// in the message text, so the fakes switch on the kwargs they receive.
vi.mock("openai", () => ({
  OpenAI: class {
    constructor(...args: unknown[]) {
      constructed.push({ sdk: "openai", args })
      return {
        chat: {
          completions: {
            create: async (kwargs: RequestKwargs) => {
              requestKwargs.push(kwargs)
              if (kwargs.tools) return toolResponse({ statement: "grounded" })
              return textResponse({ statement: "grounded" })
            },
          },
        },
      }
    }
  },
}))

vi.mock("@anthropic-ai/sdk", () => ({
  Anthropic: class {
    constructor(...args: unknown[]) {
      constructed.push({ sdk: "anthropic", args })
      return {
        messages: { create: async (kwargs: RequestKwargs) => {
          requestKwargs.push(kwargs)
          return anthropicResponse({ statement: "grounded" })
        } },
      }
    }
  },
}))

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models: { generateContent: (kwargs: RequestKwargs) => Promise<unknown> }
    constructor(...args: unknown[]) {
      constructed.push({ sdk: "google", args })
      // Assigned in the constructor: a class field initializer on a class
      // defined inside a vi.mock factory can be dropped by the transform.
      this.models = {
        generateContent: async (kwargs: RequestKwargs) => {
          requestKwargs.push(kwargs)
          return {
            candidates: [
              { content: { parts: [{ text: JSON.stringify({ statement: "grounded" }) }] } },
            ],
          }
        },
      }
    }
  },
}))

function toolResponse(payload: unknown): unknown {
  return {
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
                arguments: JSON.stringify(payload),
              },
            },
          ],
        },
      },
    ],
  }
}

function anthropicResponse(payload: unknown): unknown {
  return {
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "extract",
        input: payload,
      },
    ],
    stop_reason: "tool_use",
  }
}

/** An OpenAI response with the payload as plain JSON message content. */
function textResponse(payload: unknown): unknown {
  return {
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify(payload),
        },
      },
    ],
  }
}

const Schema = z.object({ statement: z.string() })
const messages = [{ role: "user" as const, content: "hello" }]

afterEach(() => {
  constructed.length = 0
  requestKwargs.length = 0
  vi.clearAllMocks()
})

describe("fromProvider", () => {
  it("routes vendor/model to the OpenAI-compatible table", async () => {
    await fromProvider("deepseek/deepseek-chat", { apiKey: "k" })

    expect(constructed).toEqual([
      {
        sdk: "openai",
        args: [{ apiKey: "k", baseURL: compatible.deepseek.baseURL }],
      },
    ])
  })

  it("routes every compatible vendor with its own baseURL", async () => {
    for (const [id, entry] of Object.entries(compatible)) {
      constructed.length = 0
      await fromProvider(`${id}/some-model`, { apiKey: "k" })
      expect(constructed[0]?.sdk).toBe("openai")
      expect(constructed[0]?.args[0]).toEqual({
        apiKey: "k",
        baseURL: entry.baseURL,
      })
    }
  })

  it("routes the three official SDKs", async () => {
    await fromProvider("openai/gpt-4", { apiKey: "k" })
    await fromProvider("anthropic/claude-4", { apiKey: "k" })
    await fromProvider("google/gemini-2", { apiKey: "k" })

    expect(constructed.map((c) => c.sdk)).toEqual(["openai", "anthropic", "google"])
    for (const c of constructed) {
      expect(c.args[0]).toEqual({ apiKey: "k" })
    }
  })

  it("accepts a bare vendor name without a model", async () => {
    await fromProvider("groq", { apiKey: "k" })
    expect(constructed[0]?.args[0]).toEqual({
      apiKey: "k",
      baseURL: compatible.groq.baseURL,
    })
  })

  it("lets options.baseURL override the table", async () => {
    await fromProvider("deepseek/x", { apiKey: "k", baseURL: "https://proxy.example.com/v1" })
    expect(constructed[0]?.args[0]).toEqual({
      apiKey: "k",
      baseURL: "https://proxy.example.com/v1",
    })
  })

  it("omits the constructor options object when no apiKey is given", async () => {
    // The SDK then reads its own environment variable.
    await fromProvider("openai/gpt-4")
    expect(constructed[0]?.args[0]).toBeUndefined()
  })

  it("applies the compatible table's mode as the default, overridable", async () => {
    // Table default for deepseek is TOOLS: the request carries a tools array.
    const toolsClient = await fromProvider("deepseek/x", { apiKey: "k" })
    await toolsClient.create({ model: "x", schema: Schema, messages })
    expect(requestKwargs[0]?.tools).toBeDefined()

    // An explicit mode wins over the table: MD_JSON sends none.
    requestKwargs.length = 0
    const mdJsonClient = await fromProvider("deepseek/x", {
      apiKey: "k",
      mode: "MD_JSON",
    })
    await mdJsonClient.create({ model: "x", schema: Schema, messages })
    expect(requestKwargs[0]?.tools).toBeUndefined()
  })

  it("applies official-SDK default modes", async () => {
    const anthropicClient = await fromProvider("anthropic/x", { apiKey: "k" })
    await anthropicClient.create({ model: "x", schema: Schema, messages })
    expect(requestKwargs[0]?.tools).toBeDefined()

    requestKwargs.length = 0
    const googleClient = await fromProvider("google/x", { apiKey: "k" })
    await googleClient.create({ model: "x", schema: Schema, messages })
    // GEMINI_JSON mode: response mime type set, no function declarations.
    expect(requestKwargs[0]?.tools).toBeUndefined()
  })

  it("lists supported vendors on an unknown provider", async () => {
    await expect(fromProvider("foobar/x")).rejects.toThrow(
      /foobar.*Supported vendors: openai, anthropic, google, deepseek, groq, openrouter, together, moonshot/,
    )
  })

  it("round-trips a create() call through the routed client", async () => {
    const client = await fromProvider("deepseek/x", { apiKey: "k" })
    const data = await client.create({
      model: "deepseek-chat",
      schema: Schema,
      messages,
    })
    expect(data).toEqual({ statement: "grounded" })
  })
})
