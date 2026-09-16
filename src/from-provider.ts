import { toLLMClient } from "./client.js"
import { extract } from "./extract.js"
import { extractIterable } from "./iterable.js"
import { extractPartial } from "./partial.js"
import { compatible, type CompatibleProvider } from "./providers.js"
import type { RubricClient, WrapOptions } from "./types.js"
import type { AnthropicMessagesClient } from "./adapters/anthropic.js"
import type { GeminiModelsClient } from "./adapters/gemini.js"
import type { OpenAIChatClient } from "./adapters/openai.js"

/** Vendors the router can build a client for. */
export type ProviderSpec =
  | "openai"
  | "anthropic"
  | "google"
  | keyof typeof compatible

/** Extra construction options beyond the usual wrap-level ones. */
export type FromProviderOptions = WrapOptions & {
  /**
   * API key handed to the constructed SDK. Omit it and the SDK reads its own
   * environment variable (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, …).
   */
  apiKey?: string
  /**
   * Overrides the gateway URL from the `compatible` table. Only meaningful for
   * the OpenAI-compatible vendors; must be the `/v1` root.
   */
  baseURL?: string
}

type ProviderClient =
  | OpenAIChatClient
  | AnthropicMessagesClient
  | GeminiModelsClient

/**
 * Load an SDK lazily so a user only needs the package their provider routes
 * to, and only at the moment they route to it.
 */
async function loadSdk(
  name: "@anthropic-ai/sdk" | "@google/genai" | "openai",
): Promise<{
  OpenAI?: new (options?: { apiKey?: string; baseURL?: string }) => unknown
  Anthropic?: new (options?: { apiKey?: string }) => unknown
  GoogleGenAI?: new (options: { apiKey?: string }) => { models: unknown }
}> {
  try {
    return await import(name)
  } catch (cause) {
    throw new Error(
      `Routing to this provider requires the optional dependency ${name}. ` +
        `Install it with \`pnpm add ${name}\`.`,
      { cause },
    )
  }
}

/**
 * Build a wrapped client from a provider string, the way Python instructor's
 * `from_provider("vendor/model")` does.
 *
 * The vendor (the part before the `/`, or the whole string when there is no
 * slash) picks the SDK and default mode. The model part is accepted and
 * ignored: `create()` takes an explicit `model` on every call, so there is
 * nothing for the router to remember.
 *
 * - `"openai"`, `"anthropic"`, `"google"` construct the official SDKs.
 * - `"deepseek"`, `"groq"`, `"openrouter"`, `"together"`, `"moonshot"`
 *   construct an OpenAI client pointed at the gateway from the `compatible`
 *   table, with that table's default mode.
 * - Anything else throws, listing the supported vendors.
 *
 * Async because the SDK loads dynamically: an application that never routes
 * to Anthropic does not need `@anthropic-ai/sdk` installed, let alone loaded.
 */
export async function fromProvider(
  provider: string,
  options?: FromProviderOptions,
): Promise<RubricClient> {
  const vendor = (provider.split("/")[0] ?? provider).trim()
  let client: ProviderClient

  if (vendor === "openai") {
    const { OpenAI } = await loadSdk("openai")
    if (!OpenAI) throw new Error("openai SDK loaded without an OpenAI constructor")
    client = new OpenAI(
      options?.apiKey !== undefined ? { apiKey: options.apiKey } : undefined,
    ) as OpenAIChatClient
  } else if (vendor === "anthropic") {
    const { Anthropic } = await loadSdk("@anthropic-ai/sdk")
    if (!Anthropic) throw new Error("@anthropic-ai/sdk loaded without an Anthropic constructor")
    client = new Anthropic(
      options?.apiKey !== undefined ? { apiKey: options.apiKey } : undefined,
    ) as AnthropicMessagesClient
  } else if (vendor === "google") {
    const { GoogleGenAI } = await loadSdk("@google/genai")
    if (!GoogleGenAI) throw new Error("@google/genai loaded without a GoogleGenAI constructor")
    // Pass the whole instance, not `.models`: toLLMClient's guard checks
    // client.models.generateContent, so the guard needs the outer object.
    client = new GoogleGenAI({
      ...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    }) as GeminiModelsClient
  } else if (vendor in compatible) {
    const entry = compatible[vendor as keyof typeof compatible] as CompatibleProvider
    const { OpenAI } = await loadSdk("openai")
    if (!OpenAI) throw new Error("openai SDK loaded without an OpenAI constructor")
    client = new OpenAI({
      ...(options?.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      baseURL: options?.baseURL ?? entry.baseURL,
    }) as OpenAIChatClient
    // The compatible table encodes per-gateway mode wisdom (forced
    // tool_choice fails on some thinking models). Apply it as the default,
    // still overridable by an explicit mode in options.
    options = { mode: entry.mode, ...options }
  } else {
    const known = ["openai", "anthropic", "google", ...Object.keys(compatible)]
    throw new Error(
      `Unknown provider "${provider}". Supported vendors: ${known.join(", ")}. ` +
        'For any other OpenAI-compatible gateway, construct it yourself: new OpenAI({ baseURL }) and wrap() it.',
    )
  }

  const { llm, defaults } = toLLMClient(client, options)
  return {
    create(params) {
      return extract(llm, params, defaults)
    },
    createPartial(params) {
      return extractPartial(llm, params, defaults)
    },
    createIterable(params) {
      return extractIterable(llm, params, defaults)
    },
  }
}
