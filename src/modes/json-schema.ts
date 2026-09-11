import type { ZodTypeAny } from "zod"
import { JsonParseError, type SchemaValidationError } from "../errors.js"
import { assertOpenAiStrictSchema, llmJsonSchemaFromZod } from "../schema.js"
import type { RequestKwargs } from "../types.js"
import {
  choiceMessage,
  EXTRACT_NAME,
  openaiContentDelta,
  parseJsonText,
  reaskWithUserMessage,
} from "./helpers.js"
import type { ModeHandler } from "./types.js"

export const jsonSchemaHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    const jsonSchema = llmJsonSchemaFromZod(schema)
    assertOpenAiStrictSchema(jsonSchema)
    return {
      ...kwargs,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: EXTRACT_NAME,
          strict: true,
          schema: jsonSchema,
        },
      },
    }
  },

  parseResponse(raw: unknown): unknown {
    const content = choiceMessage(raw)?.["content"]
    if (typeof content !== "string" || content.trim() === "") {
      throw new JsonParseError("Response has no JSON content", raw)
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

  deltaFromChunk(raw: unknown): string {
    return openaiContentDelta(raw)
  },
}
