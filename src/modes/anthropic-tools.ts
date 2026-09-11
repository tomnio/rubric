import type { ZodTypeAny } from "zod"
import {
  formatError,
  JsonParseError,
  type SchemaValidationError,
} from "../errors.js"
import { llmJsonSchemaFromZod } from "../schema.js"
import type { ContentBlock, Message, RequestKwargs } from "../types.js"
import { asRecord, EXTRACT_NAME } from "./helpers.js"
import type { ModeHandler } from "./types.js"

const DEFAULT_MAX_TOKENS = 1024

function contentBlocks(raw: unknown): Record<string, unknown>[] {
  const root = asRecord(raw)
  const content = root?.["content"]
  if (!Array.isArray(content)) {
    return []
  }
  return content.flatMap((block) => {
    const record = asRecord(block)
    return record ? [record] : []
  })
}

function toolUseBlock(
  raw: unknown,
): { id: string; name: string; input: unknown } | undefined {
  for (const block of contentBlocks(raw)) {
    if (block["type"] !== "tool_use") {
      continue
    }
    const id = block["id"]
    const name = block["name"]
    if (typeof id !== "string" || typeof name !== "string") {
      continue
    }
    return { id, name, input: block["input"] }
  }
  return undefined
}

export const anthropicToolsHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    const systemParts: string[] = []
    const messages: Message[] = []
    for (const message of kwargs.messages) {
      if (message.role === "system" && typeof message.content === "string") {
        systemParts.push(message.content)
        continue
      }
      messages.push(message)
    }

    const prepared: RequestKwargs = {
      ...kwargs,
      messages,
      max_tokens: kwargs.max_tokens ?? DEFAULT_MAX_TOKENS,
      tools: [
        {
          name: EXTRACT_NAME,
          description: "Return data that matches the schema.",
          input_schema: llmJsonSchemaFromZod(schema),
        },
      ],
      tool_choice: {
        type: "tool",
        name: EXTRACT_NAME,
        disable_parallel_tool_use: true,
      },
    }
    if (systemParts.length > 0) {
      prepared.system = systemParts.join("\n\n")
    }
    return prepared
  },

  parseResponse(raw: unknown): unknown {
    const toolUse = toolUseBlock(raw)
    if (!toolUse) {
      throw new JsonParseError("Response has no tool_use block", raw)
    }
    const { input } = toolUse
    if (typeof input === "string") {
      try {
        return JSON.parse(input) as unknown
      } catch {
        throw new JsonParseError("tool_use input is not valid JSON", raw)
      }
    }
    if (input === undefined) {
      throw new JsonParseError("tool_use input is missing", raw)
    }
    return input
  },

  handleReask(
    kwargs: RequestKwargs,
    raw: unknown,
    error: JsonParseError | SchemaValidationError,
  ): RequestKwargs {
    const toolUse = toolUseBlock(raw)
    const errorText = formatError(error)
    const assistantContent: ContentBlock[] = []
    for (const block of contentBlocks(raw)) {
      if (block["type"] === "tool_use" && typeof block["id"] === "string") {
        assistantContent.push({
          type: "tool_use",
          id: block["id"],
          name: typeof block["name"] === "string" ? block["name"] : EXTRACT_NAME,
          input: block["input"],
        })
      } else if (block["type"] === "text" && typeof block["text"] === "string") {
        assistantContent.push({ type: "text", text: block["text"] })
      }
    }

    const followUp: Message = toolUse
      ? {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: errorText,
              is_error: true,
            },
          ],
        }
      : { role: "user", content: errorText }

    const assistant: Message = {
      role: "assistant",
      content: assistantContent.length > 0 ? assistantContent : null,
    }

    return {
      ...kwargs,
      messages: [...kwargs.messages, assistant, followUp],
    }
  },

  deltaFromChunk(raw: unknown): string {
    const root = asRecord(raw)
    const delta = asRecord(root?.["delta"])
    const partial = delta?.["partial_json"]
    if (typeof partial === "string") {
      return partial
    }
    return ""
  },
}
