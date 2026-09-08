import type { RubricClient, WrapOptions } from "./types.ts"

export type {
  CreateParams,
  Message,
  Mode,
  RubricClient,
  WrapOptions,
} from "./types.ts"

export {
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.ts"

/**
 * Wrap an LLM client with schema-validated create().
 * The original client is not mutated.
 *
 * Not implemented in the skeleton; later steps fill this in.
 */
export function wrap(_client: unknown, _options?: WrapOptions): RubricClient {
  throw new Error("wrap() is not implemented")
}
