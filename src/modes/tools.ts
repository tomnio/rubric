import type { ZodTypeAny } from "zod"
import {
  formatError,
  JsonParseError,
  type SchemaValidationError,
} from "../errors.ts"
import { jsonSchemaFromZod } from "../schema.ts"
import type { Message, RequestKwargs, ToolCall } from "../types.ts"
import type { ModeHandler } from "./types.ts"

export const EXTRACT_TOOL_NAME = "extract"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

export const toolsHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    return {
      ...kwargs,
      tools: [
        {
          type: "function",
          function: {
            name: EXTRACT_TOOL_NAME,
            description: "Return data that matches the schema.",
            parameters: jsonSchemaFromZod(schema),
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: EXTRACT_TOOL_NAME },
      },
    }
  },

  parseResponse(raw: unknown): unknown {
    const root = asRecord(raw)
    const choices = root?.["choices"]
    const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined
    const message = asRecord(choice?.["message"])
    const toolCalls = message?.["tool_calls"]
    const call = Array.isArray(toolCalls) ? asRecord(toolCalls[0]) : undefined
    const fn = asRecord(call?.["function"])
    const args = fn?.["arguments"]

    if (typeof args !== "string") {
      throw new JsonParseError("Response has no tool call arguments", raw)
    }

    try {
      return JSON.parse(args) as unknown
    } catch {
      throw new JsonParseError("Tool call arguments are not valid JSON", raw)
    }
  },

  handleReask(
    kwargs: RequestKwargs,
    raw: unknown,
    error: JsonParseError | SchemaValidationError,
  ): RequestKwargs {
    const assistant = assistantMessageFromRaw(raw)
    const toolCallId = assistant.tool_calls?.[0]?.id
    const followUp: Message = toolCallId
      ? { role: "tool", tool_call_id: toolCallId, content: formatError(error) }
      : { role: "user", content: formatError(error) }

    return {
      ...kwargs,
      messages: [...kwargs.messages, assistant, followUp],
    }
  },
}

function assistantMessageFromRaw(raw: unknown): Message {
  const root = asRecord(raw)
  const choices = root?.["choices"]
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  const message = asRecord(choice?.["message"])
  const content = message?.["content"]
  const toolCalls = readToolCalls(message?.["tool_calls"])

  const assistant: Message = {
    role: "assistant",
    content: typeof content === "string" || content === null ? content : null,
  }
  if (toolCalls) {
    assistant.tool_calls = toolCalls
  }
  return assistant
}

function readToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const calls: ToolCall[] = []
  for (const item of value) {
    const call = asRecord(item)
    const fn = asRecord(call?.["function"])
    const id = call?.["id"]
    const name = fn?.["name"]
    const args = fn?.["arguments"]
    if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") {
      continue
    }
    calls.push({
      id,
      type: "function",
      function: { name, arguments: args },
    })
  }
  return calls.length > 0 ? calls : undefined
}
