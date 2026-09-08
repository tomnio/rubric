import { extract } from "./extract.ts"
import type { LLMClient, RubricClient, WrapOptions } from "./types.ts"

export type {
  CreateParams,
  LLMClient,
  Message,
  Mode,
  RequestKwargs,
  RubricClient,
  WrapOptions,
} from "./types.ts"

export {
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.ts"

export { jsonSchemaFromZod } from "./schema.ts"
export type { JsonSchema } from "./schema.ts"

/**
 * Wrap an LLM client with schema-validated create().
 * The original client is not mutated.
 */
export function wrap(client: LLMClient, options?: WrapOptions): RubricClient {
  return {
    create(params) {
      return extract(client, params, options)
    },
  }
}
