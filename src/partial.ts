import { parse as parsePartialJson } from "partial-json"
import type { z } from "zod"
import { JsonParseError } from "./errors.ts"
import { handlerFor } from "./modes/registry.ts"
import { coerceParsedValue, deepPartialZod } from "./schema.ts"
import type {
  CreateParams,
  DeepPartial,
  LLMClient,
  Mode,
  WrapOptions,
} from "./types.ts"

const DEFAULT_MODE: Mode = "TOOLS"

function jsonSlice(buffer: string): string {
  const fence = buffer.match(/```(?:json)?\s*([\s\S]*)$/i)
  if (fence?.[1] !== undefined) {
    return fence[1]
  }
  const start = buffer.search(/[{[]/)
  return start >= 0 ? buffer.slice(start) : buffer
}

function parseIncomplete(buffer: string): unknown {
  const slice = jsonSlice(buffer).trim()
  if (slice === "") {
    return undefined
  }
  try {
    return parsePartialJson(slice) as unknown
  } catch {
    return undefined
  }
}

/**
 * Stream incomplete snapshots. Does not reask.
 * TOOLS / JSON_SCHEMA / MD_JSON only (OpenAI-shaped chunks).
 */
export async function* extractPartial<T extends z.ZodType>(
  client: LLMClient,
  params: CreateParams<T>,
  defaults?: WrapOptions,
): AsyncGenerator<DeepPartial<z.infer<T>>> {
  const mode = params.mode ?? defaults?.mode ?? DEFAULT_MODE
  if (mode === "ANTHROPIC_TOOLS") {
    throw new Error("createPartial() does not support ANTHROPIC_TOOLS yet")
  }
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
