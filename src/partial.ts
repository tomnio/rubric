import type { z } from "zod"
import { rejectTokenBudgetForStream } from "./budget.js"
import { JsonCompleteness } from "./completeness.js"
import { JsonParseError, OutputTruncatedError } from "./errors.js"
import { attemptMeta, safeEmit } from "./hooks.js"
import { handlerFor } from "./modes/registry.js"
import { applyRequestExtras, mergeSamplingExtras } from "./request.js"
import { coerceParsedValue } from "./schema.js"
import { buildSnapshot } from "./snapshot.js"
import { jsonSlice, parseIncomplete } from "./stream-json.js"
import { truncationReason } from "./truncation.js"
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
  // A stream has no reask to guard, and its usage arrives incrementally, so a
  // budget could not be enforced before the call that spends it. Reject it
  // rather than accept a setting that does nothing.
  rejectTokenBudgetForStream(
    params.tokenBudget ?? defaults?.tokenBudget,
    "createPartial",
  )
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
  // The marker on the final chunk, if the provider stopped at its output cap.
  // Partial output is this call's normal shape, so a truncated stream is not an
  // error by itself — but if nothing was ever parseable, "truncated" is the
  // honest reason, not "no parseable JSON".
  let truncated: string | undefined

  params.signal?.throwIfAborted()
  for await (const chunk of client.chatCompletionsStream(
    kwargs,
    params.signal ? { signal: params.signal } : undefined,
  )) {
    usage = mergeChunkUsage(usage, chunk)
    truncated = truncationReason(chunk) ?? truncated
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

  safeEmit("onUsage", hooks.onUsage, [
    finishStreamUsage(usage),
    attemptMeta(1, 1, true),
  ])
  if (lastSerialized === "") {
    if (truncated !== undefined) {
      throw new OutputTruncatedError(
        `Output was cut off by the provider's token limit (${truncated}) before any JSON arrived. Raise max_tokens, or extract a smaller schema.`,
        { reason: truncated, raw: buffer, attempts: 1 },
      )
    }
    throw new JsonParseError("Stream ended without parseable JSON", buffer)
  }
}
