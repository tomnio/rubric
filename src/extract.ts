import type { z } from "zod"
import {
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.ts"
import { handlerFor } from "./modes/registry.ts"
import { coerceParsedValue } from "./schema.ts"
import type { CreateParams, Hooks, LLMClient, Mode, WrapOptions } from "./types.ts"

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MODE: Mode = "TOOLS"

export async function extract<T extends z.ZodType>(
  client: LLMClient,
  params: CreateParams<T>,
  defaults?: WrapOptions,
): Promise<z.infer<T>> {
  const mode = params.mode ?? defaults?.mode ?? DEFAULT_MODE
  const maxRetries = params.maxRetries ?? defaults?.maxRetries ?? DEFAULT_MAX_RETRIES
  const hooks: Hooks = { ...defaults?.hooks, ...params.hooks }
  const attemptsAllowed = maxRetries + 1
  const handler = handlerFor(mode)
  let kwargs = handler.prepareRequest(params.schema, {
    model: params.model,
    messages: params.messages,
  })
  let lastError: JsonParseError | SchemaValidationError | undefined
  let attempts = 0

  while (attempts < attemptsAllowed) {
    attempts += 1
    hooks.onRequest?.(kwargs)
    const raw = await client.chatCompletionsCreate(kwargs)

    try {
      const json = coerceParsedValue(params.schema, handler.parseResponse(raw))
      // Includes .refine() / .superRefine(); those issues go into reask text.
      const parsed = params.schema.safeParse(json)
      if (!parsed.success) {
        throw new SchemaValidationError(
          "Output failed schema validation",
          parsed.error.issues,
        )
      }
      hooks.onSuccess?.(parsed.data)
      return parsed.data
    } catch (err) {
      if (!(err instanceof JsonParseError || err instanceof SchemaValidationError)) {
        throw err
      }
      lastError = err
      hooks.onParseError?.(err)
      if (attempts >= attemptsAllowed) {
        break
      }
      kwargs = handler.handleReask(kwargs, raw, err)
    }
  }

  throw new RetryExhaustedError(
    `Failed after ${attempts} attempt(s)`,
    attempts,
    lastError as JsonParseError | SchemaValidationError,
  )
}
