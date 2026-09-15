import { z } from "zod"
import { rejectTokenBudgetForStream } from "./budget.js"
import { runWithContext } from "./context.js"
import { JsonParseError } from "./errors.js"
import { attemptMeta, safeEmit } from "./hooks.js"
import { handlerFor } from "./modes/registry.js"
import { applyRequestExtras, mergeSamplingExtras } from "./request.js"
import { coerceParsedValue } from "./schema.js"
import { parseIncomplete } from "./stream-json.js"
import type { CreateParams, Hooks, LLMClient, Mode, WrapOptions } from "./types.js"
import { emptyUsage, finishStreamUsage, mergeChunkUsage } from "./usage.js"

const DEFAULT_MODE: Mode = "TOOLS"

/**
 * Stream fully validated items from a JSON array. Incomplete trailing
 * objects are held until they pass the item schema. Does not reask.
 *
 * `schema` is the **item** type; the model is asked for an array of that type.
 */
export async function* extractIterable<T extends z.ZodType>(
  client: LLMClient,
  params: CreateParams<T>,
  defaults?: WrapOptions,
): AsyncGenerator<z.infer<T>> {
  const mode = params.mode ?? defaults?.mode ?? DEFAULT_MODE
  rejectTokenBudgetForStream(
    params.tokenBudget ?? defaults?.tokenBudget,
    "createIterable",
  )
  if (!client.chatCompletionsStream) {
    throw new Error("LLMClient does not implement chatCompletionsStream")
  }

  const hooks: Hooks = { ...defaults?.hooks, ...params.hooks }
  const arraySchema = z.array(params.schema)
  const handler = handlerFor(mode)
  const kwargs = applyRequestExtras(
    handler.prepareRequest(arraySchema, {
      model: params.model,
      messages: params.messages,
    }),
    mergeSamplingExtras(defaults, params),
  )
  let buffer = ""
  let yielded = 0
  let usage = emptyUsage()

  params.signal?.throwIfAborted()
  for await (const chunk of client.chatCompletionsStream(
    kwargs,
    params.signal ? { signal: params.signal } : undefined,
  )) {
    usage = mergeChunkUsage(usage, chunk)
    buffer += handler.deltaFromChunk(chunk)
    const json = coerceParsedValue(arraySchema, parseIncomplete(buffer))
    if (!Array.isArray(json)) {
      continue
    }
    while (yielded < json.length) {
      const item = json[yielded]
      // safeParseAsync, not safeParse: a schema built with llmRefine() (or any
      // async z.refine) makes Zod throw "Async refinement encountered during
      // synchronous parse" — a raw Zod error escaping to the caller. The
      // context is what lets cited() see the source text and llmRefine() find
      // a model, matching create().
      const parsed = await runWithContext(
        { citation: params.context, model: params.model },
        () => params.schema.safeParseAsync(item),
      )
      if (!parsed.success) {
        break
      }
      yield parsed.data
      yielded += 1
    }
  }

  safeEmit("onUsage", hooks.onUsage, [
    finishStreamUsage(usage),
    attemptMeta(1, 1, true),
  ])
  if (yielded === 0) {
    throw new JsonParseError("Stream ended without a complete list item", buffer)
  }
}
