import type { ZodTypeAny } from "zod"
import { JsonParseError } from "../errors.ts"
import { jsonSchemaFromZod } from "../schema.ts"
import type { RequestKwargs } from "../types.ts"
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

  handleReask(): RequestKwargs {
    throw new Error("TOOLS reask is not implemented")
  },
}
