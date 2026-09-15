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
import { extract } from "./extract.js"
import { extractIterable } from "./iterable.js"
import { extractPartial } from "./partial.js"
import type { LLMClient, RubricClient, WrapOptions } from "./types.js"

export type {
  CallOptions,
  ContentBlock,
  CreateParams,
  DeepPartial,
  Hooks,
  AnthropicImageBlock,
  ImageUrlBlock,
  LLMClient,
  Message,
  Mode,
  RequestKwargs,
  RubricClient,
  SamplingExtras,
  ToolCall,
  WrapOptions,
} from "./types.js"

export {
  formatError,
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
  TokenBudgetError,
  TokenBudgetExceeded,
  TokenUsageUnavailableError,
} from "./errors.js"

export {
  assertOpenAiStrictSchema,
  coerceParsedValue,
  deepPartialZod,
  jsonSchemaFromZod,
  llmJsonSchemaFromZod,
} from "./schema.js"
export type { JsonSchema } from "./schema.js"
export type { TokenUsage } from "./usage.js"
export type { OpenAIChatClient } from "./adapters/openai.js"
export type { AnthropicMessagesClient } from "./adapters/anthropic.js"
export type { GeminiModelsClient } from "./adapters/gemini.js"
export { compatible } from "./providers.js"
export type { CompatibleProvider } from "./providers.js"
export { maybe } from "./maybe.js"
export { cited } from "./citation.js"
export { llmRefine, Validator } from "./judge.js"
export type { LlmRefineOptions } from "./judge.js"
export {
  anthropicImageBase64,
  anthropicImageUrl,
  imageUrl,
  toAnthropicContent,
} from "./image.js"

/**
 * Wrap an LLM client with schema-validated create().
 * Accepts a fake `LLMClient`, OpenAI `chat.completions`, or Anthropic `messages`.
 * The original client is not mutated.
 */
export function wrap(
  client:
    | LLMClient
    | OpenAIChatClient
    | AnthropicMessagesClient
    | GeminiModelsClient,
  options?: WrapOptions,
): RubricClient {
  let llm: LLMClient
  let defaults = options
  if (isLLMClient(client)) {
    llm = client
  } else if (isOpenAIChatClient(client)) {
    llm = fromOpenAI(client)
  } else if (isAnthropicMessagesClient(client)) {
    llm = fromAnthropic(client)
    defaults = { mode: "ANTHROPIC_TOOLS", ...options }
  } else if (isGeminiModelsClient(client)) {
    llm = fromGemini(client)
    defaults = { mode: "GEMINI_JSON", ...options }
  } else {
    throw new Error(
      "wrap() expects an LLMClient, OpenAI chat.completions, Anthropic messages, or Gemini models.generateContent client",
    )
  }

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
