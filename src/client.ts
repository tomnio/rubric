import {
  fromAnthropic,
  isAnthropicMessagesClient,
  type AnthropicMessagesClient,
} from "./adapters/anthropic.js"
import {
  fromGemini,
  isGeminiModelsClient,
  type GeminiModelsClient,
} from "./adapters/gemini.js"
import {
  fromOpenAI,
  isLLMClient,
  isOpenAIChatClient,
  type OpenAIChatClient,
} from "./adapters/openai.js"
import type { LLMClient, WrapOptions } from "./types.js"

/** Any client `wrap()` accepts: a fake `LLMClient`, or one of the SDK shapes. */
export type AnyClient =
  | LLMClient
  | OpenAIChatClient
  | AnthropicMessagesClient
  | GeminiModelsClient

/**
 * Resolve any accepted client down to an `LLMClient` plus the defaults that
 * client implies. Anthropic and Gemini get their native mode as the default.
 *
 * Shared by `wrap()` and `createDocument()` so both entry points agree on what
 * a client is and which mode it defaults to.
 */
export function toLLMClient(
  client: AnyClient,
  options?: WrapOptions,
): { llm: LLMClient; defaults: WrapOptions | undefined } {
  let defaults = options
  if (isLLMClient(client)) {
    return { llm: client, defaults }
  }
  if (isOpenAIChatClient(client)) {
    return { llm: fromOpenAI(client), defaults }
  }
  if (isAnthropicMessagesClient(client)) {
    return {
      llm: fromAnthropic(client),
      defaults: { mode: "ANTHROPIC_TOOLS", ...options },
    }
  }
  if (isGeminiModelsClient(client)) {
    return {
      llm: fromGemini(client),
      defaults: { mode: "GEMINI_JSON", ...options },
    }
  }
  throw new Error(
    "wrap() expects an LLMClient, OpenAI chat.completions, Anthropic messages, or Gemini models.generateContent client",
  )
}
