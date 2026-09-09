import {
  fromOpenAI,
  isLLMClient,
  isOpenAIChatClient,
  type OpenAIChatClient,
} from "./adapters/openai.ts"
import { extract } from "./extract.ts"
import type { LLMClient, RubricClient, WrapOptions } from "./types.ts"

export type {
  CreateParams,
  Hooks,
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

export { coerceParsedValue, jsonSchemaFromZod, llmJsonSchemaFromZod } from "./schema.ts"
export type { JsonSchema } from "./schema.ts"
export type { OpenAIChatClient } from "./adapters/openai.ts"
export { maybe } from "./maybe.ts"

/**
 * Wrap an LLM client with schema-validated create().
 * Accepts either a fake `LLMClient` or an OpenAI-shaped `chat.completions` client.
 * The original client is not mutated.
 */
export function wrap(
  client: LLMClient | OpenAIChatClient,
  options?: WrapOptions,
): RubricClient {
  let llm: LLMClient
  if (isLLMClient(client)) {
    llm = client
  } else if (isOpenAIChatClient(client)) {
    llm = fromOpenAI(client)
  } else {
    throw new Error("wrap() expects an LLMClient or an OpenAI chat.completions client")
  }

  return {
    create(params) {
      return extract(llm, params, options)
    },
  }
}
