import {
  fromAnthropic,
  isAnthropicMessagesClient,
  type AnthropicMessagesClient,
} from "./adapters/anthropic.ts"
import {
  fromOpenAI,
  isLLMClient,
  isOpenAIChatClient,
  type OpenAIChatClient,
} from "./adapters/openai.ts"
import { extract } from "./extract.ts"
import { extractIterable } from "./iterable.ts"
import { extractPartial } from "./partial.ts"
import type { LLMClient, RubricClient, WrapOptions } from "./types.ts"

export type {
  ContentBlock,
  CreateParams,
  DeepPartial,
  Hooks,
  ImageUrlBlock,
  LLMClient,
  Message,
  Mode,
  RequestKwargs,
  RubricClient,
  ToolCall,
  WrapOptions,
} from "./types.ts"

export {
  formatError,
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.ts"

export {
  coerceParsedValue,
  deepPartialZod,
  jsonSchemaFromZod,
  llmJsonSchemaFromZod,
} from "./schema.ts"
export type { JsonSchema } from "./schema.ts"
export type { OpenAIChatClient } from "./adapters/openai.ts"
export type { AnthropicMessagesClient } from "./adapters/anthropic.ts"
export { maybe } from "./maybe.ts"
export { imageUrl } from "./image.ts"

/**
 * Wrap an LLM client with schema-validated create().
 * Accepts a fake `LLMClient`, OpenAI `chat.completions`, or Anthropic `messages`.
 * The original client is not mutated.
 */
export function wrap(
  client: LLMClient | OpenAIChatClient | AnthropicMessagesClient,
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
  } else {
    throw new Error(
      "wrap() expects an LLMClient, OpenAI chat.completions client, or Anthropic messages client",
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
