import type { ZodTypeAny } from "zod"
import { JsonParseError, type SchemaValidationError } from "../errors.ts"
import { jsonSchemaFromZod } from "../schema.ts"
import type { RequestKwargs } from "../types.ts"
import { choiceMessage, parseJsonText, reaskWithUserMessage } from "./helpers.ts"
import type { ModeHandler } from "./types.ts"

const FENCE = /```(?:json)?\s*([\s\S]*?)```/i

function instruction(schema: ZodTypeAny): string {
  const jsonSchema = JSON.stringify(jsonSchemaFromZod(schema), null, 2)
  return [
    "Reply with only JSON inside a markdown fence:",
    "",
    "```json",
    "...",
    "```",
    "",
    "The JSON must match this schema:",
    jsonSchema,
  ].join("\n")
}

export const mdJsonHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    return {
      ...kwargs,
      messages: [
        { role: "system", content: instruction(schema) },
        ...kwargs.messages,
      ],
    }
  },

  parseResponse(raw: unknown): unknown {
    const content = choiceMessage(raw)?.["content"]
    if (typeof content !== "string" || content.trim() === "") {
      throw new JsonParseError("Response has no JSON content", raw)
    }

    const fenced = content.match(FENCE)
    if (fenced?.[1] !== undefined) {
      try {
        return JSON.parse(fenced[1]) as unknown
      } catch {
        // Fall through and try the full message.
      }
    }

    return parseJsonText(content, raw)
  },

  handleReask(
    kwargs: RequestKwargs,
    raw: unknown,
    error: JsonParseError | SchemaValidationError,
  ): RequestKwargs {
    return reaskWithUserMessage(kwargs, raw, error)
  },
}
