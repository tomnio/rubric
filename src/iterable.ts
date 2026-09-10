import { z } from "zod"
import { JsonParseError } from "./errors.ts"
import { handlerFor } from "./modes/registry.ts"
import { coerceParsedValue } from "./schema.ts"
import { parseIncomplete } from "./stream-json.ts"
import type { CreateParams, LLMClient, Mode, WrapOptions } from "./types.ts"

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
  if (mode === "ANTHROPIC_TOOLS") {
    throw new Error("createIterable() does not support ANTHROPIC_TOOLS yet")
  }
  if (!client.chatCompletionsStream) {
    throw new Error("LLMClient does not implement chatCompletionsStream")
  }

  const arraySchema = z.array(params.schema)
  const handler = handlerFor(mode)
  const kwargs = handler.prepareRequest(arraySchema, {
    model: params.model,
    messages: params.messages,
  })
  let buffer = ""
  let yielded = 0

  for await (const chunk of client.chatCompletionsStream(kwargs)) {
    buffer += handler.deltaFromChunk(chunk)
    const json = coerceParsedValue(arraySchema, parseIncomplete(buffer))
    if (!Array.isArray(json)) {
      continue
    }
    while (yielded < json.length) {
      const item = json[yielded]
      const parsed = params.schema.safeParse(item)
      if (!parsed.success) {
        break
      }
      yield parsed.data
      yielded += 1
    }
  }

  if (yielded === 0) {
    throw new JsonParseError("Stream ended without a complete list item", buffer)
  }
}
