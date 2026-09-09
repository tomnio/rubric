import type { ZodTypeAny } from "zod"
import { JsonParseError, type SchemaValidationError } from "../errors.ts"
import { llmJsonSchemaFromZod } from "../schema.ts"
import type { RequestKwargs } from "../types.ts"
import {
  choiceMessage,
  EXTRACT_NAME,
  parseJsonText,
  reaskWithUserMessage,
} from "./helpers.ts"
import type { ModeHandler } from "./types.ts"

export const jsonSchemaHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    return {
      ...kwargs,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: EXTRACT_NAME,
          strict: true,
          schema: llmJsonSchemaFromZod(schema),
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
}
