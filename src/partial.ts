import type { z } from "zod"
import { JsonCompleteness } from "./completeness.js"
import { JsonParseError } from "./errors.js"
import { handlerFor } from "./modes/registry.js"
import { applyRequestExtras, mergeSamplingExtras } from "./request.js"
import { coerceParsedValue } from "./schema.js"
import { buildSnapshot } from "./snapshot.js"
import { jsonSlice, parseIncomplete } from "./stream-json.js"
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
 *
 * Closed subtrees are validated against the real schema, so a wrong value in a
 * field that has fully arrived is caught mid-stream. Subtrees still arriving
 * are kept structurally, without pretending their truncated values are final.
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
  const tracker = new JsonCompleteness()
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

    // The tracker reads the same slice the parser does, so paths line up.
    const slice = jsonSlice(buffer).trim()
    tracker.analyze(slice)

    const json = coerceParsedValue(params.schema, parseIncomplete(buffer))
    if (json === undefined) {
      continue
    }

    const built = buildSnapshot(json, params.schema, tracker)
    if (!built.ok) {
      continue
    }

    const serialized = JSON.stringify(built.value)
    if (serialized === lastSerialized) {
      continue
    }
    lastSerialized = serialized
    yield built.value as DeepPartial<z.infer<T>>
  }

  hooks.onUsage?.(finishStreamUsage(usage))
  if (lastSerialized === "") {
    throw new JsonParseError("Stream ended without parseable JSON", buffer)
  }
}
