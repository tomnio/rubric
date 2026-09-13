import type { z } from "zod"
import {
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.js"
import { handlerFor } from "./modes/registry.js"
import { coerceParsedValue } from "./schema.js"
import type { CreateParams, Hooks, LLMClient, Mode, WrapOptions } from "./types.js"
import { addUsage, emptyUsage } from "./usage.js"

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
  let usage = emptyUsage()

  while (attempts < attemptsAllowed) {
    attempts += 1
    hooks.onRequest?.(kwargs)
    const raw = await client.chatCompletionsCreate(kwargs)
    usage = addUsage(usage, raw)

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
      hooks.onUsage?.(usage)
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

  hooks.onUsage?.(usage)
  throw new RetryExhaustedError(
    `Failed after ${attempts} attempt(s)`,
    attempts,
    lastError as JsonParseError | SchemaValidationError,
    usage,
  )
}
