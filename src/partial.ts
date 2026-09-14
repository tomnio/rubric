import type { z } from "zod"
import { JsonParseError } from "./errors.js"
import { handlerFor } from "./modes/registry.js"
import { applyRequestExtras, mergeSamplingExtras } from "./request.js"
import { coerceParsedValue, deepPartialZod } from "./schema.js"
import { parseIncomplete } from "./stream-json.js"
import type {
  CreateParams,
  DeepPartial,
  Hooks,
  LLMClient,
  Mode,
  WrapOptions,
} from "./types.js"
import { emptyUsage, finishStreamUsage, mergeChunkUsage } from "./usage.js"

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

  const hooks: Hooks = { ...defaults?.hooks, ...params.hooks }
  const handler = handlerFor(mode)
  const kwargs = applyRequestExtras(
    handler.prepareRequest(params.schema, {
      model: params.model,
      messages: params.messages,
    }),
    mergeSamplingExtras(defaults, params),
  )
  const partialSchema = deepPartialZod(params.schema)
  let buffer = ""
  let lastSerialized = ""
  let usage = emptyUsage()

  params.signal?.throwIfAborted()
  for await (const chunk of client.chatCompletionsStream(
    kwargs,
    params.signal ? { signal: params.signal } : undefined,
  )) {
    usage = mergeChunkUsage(usage, chunk)
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

  hooks.onUsage?.(finishStreamUsage(usage))
  if (lastSerialized === "") {
    throw new JsonParseError("Stream ended without parseable JSON", buffer)
  }
}
