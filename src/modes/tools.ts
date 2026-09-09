import type { ZodTypeAny } from "zod"
import {
  formatError,
  JsonParseError,
  type SchemaValidationError,
} from "../errors.ts"
import { llmJsonSchemaFromZod } from "../schema.ts"
import type { Message, RequestKwargs } from "../types.ts"
import {
  asRecord,
  assistantMessageFromRaw,
  choiceMessage,
  EXTRACT_NAME,
  openaiToolArgsDelta,
  parseJsonText,
  readToolCalls,
} from "./helpers.ts"
import type { ModeHandler } from "./types.ts"

export const EXTRACT_TOOL_NAME = EXTRACT_NAME

export const toolsHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    return {
      ...kwargs,
      tools: [
        {
          type: "function",
          function: {
            name: EXTRACT_NAME,
            description: "Return data that matches the schema.",
            parameters: llmJsonSchemaFromZod(schema),
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: EXTRACT_NAME },
      },
    }
  },

  parseResponse(raw: unknown): unknown {
    const message = choiceMessage(raw)
    const toolCalls = message?.["tool_calls"]
    const call = Array.isArray(toolCalls) ? asRecord(toolCalls[0]) : undefined
    const fn = asRecord(call?.["function"])
    const args = fn?.["arguments"]

    if (typeof args !== "string") {
      throw new JsonParseError("Response has no tool call arguments", raw)
    }

    return parseJsonText(args, raw, "Tool call arguments are not valid JSON")
  },

  handleReask(
    kwargs: RequestKwargs,
    raw: unknown,
    error: JsonParseError | SchemaValidationError,
  ): RequestKwargs {
    const assistant = assistantMessageFromRaw(raw)
    const toolCallId = readToolCalls(choiceMessage(raw)?.["tool_calls"])?.[0]?.id
    const followUp: Message = toolCallId
      ? { role: "tool", tool_call_id: toolCallId, content: formatError(error) }
      : { role: "user", content: formatError(error) }

    return {
      ...kwargs,
      messages: [...kwargs.messages, assistant, followUp],
    }
  },

  deltaFromChunk(raw: unknown): string {
    return openaiToolArgsDelta(raw)
  },
}
