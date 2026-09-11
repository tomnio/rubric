import type { z } from "zod"
import { JsonParseError } from "./errors.ts"
import { handlerFor } from "./modes/registry.ts"
import { coerceParsedValue, deepPartialZod } from "./schema.ts"
import { parseIncomplete } from "./stream-json.ts"
import type {
  CreateParams,
  DeepPartial,
  LLMClient,
  Mode,
  WrapOptions,
} from "./types.ts"

const DEFAULT_MODE: Mode = "TOOLS"

/**
 * Stream incomplete snapshots. Does not reask.
 */
export async function* extractPartial<T extends z.ZodType>(
  client: LLMClient,
  params: CreateParams<T>,
  defaults?: WrapOptions,
): AsyncGenerator<DeepPartial<z.infer<T>>> {
  const mode = params.mode ?? defaults?.mode ?? DEFAULT_MODE
  if (!client.chatCompletionsStream) {
    throw new Error("LLMClient does not implement chatCompletionsStream")
  }

  const handler = handlerFor(mode)
  const kwargs = handler.prepareRequest(params.schema, {
    model: params.model,
    messages: params.messages,
  })
  const partialSchema = deepPartialZod(params.schema)
  let buffer = ""
  let lastSerialized = ""

  for await (const chunk of client.chatCompletionsStream(kwargs)) {
    buffer += handler.deltaFromChunk(chunk)
    const json = coerceParsedValue(params.schema, parseIncomplete(buffer))
    if (json === undefined) {
      continue
    }
    const parsed = partialSchema.safeParse(json)
    if (!parsed.success) {
      continue
    }
    const serialized = JSON.stringify(parsed.data)
    if (serialized === lastSerialized) {
      continue
    }
    lastSerialized = serialized
    yield parsed.data as DeepPartial<z.infer<T>>
  }

  if (lastSerialized === "") {
    throw new JsonParseError("Stream ended without parseable JSON", buffer)
  }
}
