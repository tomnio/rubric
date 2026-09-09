import type { ZodTypeAny } from "zod"
import type { JsonParseError, SchemaValidationError } from "../errors.ts"
import type { RequestKwargs } from "../types.ts"

/** One wire format: how schema is sent, how JSON is read, how errors are attached. */
export type ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs
  parseResponse(raw: unknown): unknown
  handleReask(
    kwargs: RequestKwargs,
    raw: unknown,
    error: JsonParseError | SchemaValidationError,
  ): RequestKwargs
  /** Text delta from a streaming chunk. Empty string if this chunk has none. */
  deltaFromChunk(raw: unknown): string
}
