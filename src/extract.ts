import type { z } from "zod"
import {
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.ts"
import { toolsHandler } from "./modes/tools.ts"
import type { CreateParams, LLMClient, Mode } from "./types.ts"

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MODE: Mode = "TOOLS"

export async function extract<T extends z.ZodType>(
  client: LLMClient,
  params: CreateParams<T>,
  defaults?: { mode?: Mode; maxRetries?: number },
): Promise<z.infer<T>> {
  const mode = params.mode ?? defaults?.mode ?? DEFAULT_MODE
  const maxRetries = params.maxRetries ?? defaults?.maxRetries ?? DEFAULT_MAX_RETRIES
  const attemptsAllowed = maxRetries + 1

  if (mode !== "TOOLS") {
    throw new Error(`Mode "${mode}" is not implemented`)
  }

  const handler = toolsHandler
  let kwargs = handler.prepareRequest(params.schema, {
    model: params.model,
    messages: params.messages,
  })
  let lastError: JsonParseError | SchemaValidationError | undefined
  let attempts = 0

  while (attempts < attemptsAllowed) {
    attempts += 1
    const raw = await client.chatCompletionsCreate(kwargs)

    try {
      const json = handler.parseResponse(raw)
      const parsed = params.schema.safeParse(json)
      if (!parsed.success) {
        throw new SchemaValidationError(
          "Output failed schema validation",
          parsed.error.issues,
        )
      }
      return parsed.data
    } catch (err) {
      if (!(err instanceof JsonParseError || err instanceof SchemaValidationError)) {
        throw err
      }
      lastError = err
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
