import type { z } from "zod"
import { SchemaValidationError } from "./errors.ts"
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
  // maxRetries is accepted so wrap() can pass it; reask uses it in a later step.
  void (params.maxRetries ?? defaults?.maxRetries ?? DEFAULT_MAX_RETRIES)

  if (mode !== "TOOLS") {
    throw new Error(`Mode "${mode}" is not implemented`)
  }

  const kwargs = toolsHandler.prepareRequest(params.schema, {
    model: params.model,
    messages: params.messages,
  })
  const raw = await client.chatCompletionsCreate(kwargs)
  const json = toolsHandler.parseResponse(raw)
  const parsed = params.schema.safeParse(json)
  if (!parsed.success) {
    throw new SchemaValidationError(
      "Output failed schema validation",
      parsed.error.issues,
    )
  }
  return parsed.data
}
