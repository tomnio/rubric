import type { ZodTypeAny } from "zod"
import {
  formatError,
  JsonParseError,
  type SchemaValidationError,
} from "../errors.js"
import { llmJsonSchemaFromZod } from "../schema.js"
import type { Message, RequestKwargs } from "../types.js"
import { asRecord, parseJsonText } from "./helpers.js"
import type { ModeHandler } from "./types.js"

function textFromContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content
  }
  if (content === null) {
    return ""
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text
      }
      return ""
    })
    .join("")
}

function partsFromMessage(message: Message): unknown[] {
  const content = message.content
  if (typeof content === "string") {
    return [{ text: content }]
  }
  if (content === null) {
    return [{ text: "" }]
  }
  const parts: unknown[] = []
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ text: block.text })
    } else if (block.type === "image_url") {
      parts.push({ fileData: { fileUri: block.image_url.url } })
    }
  }
  return parts.length > 0 ? parts : [{ text: textFromContent(content) }]
}

export function geminiPayloadFromMessages(messages: Message[]): {
  contents: unknown[]
  systemInstruction?: unknown
} {
  const systemParts: string[] = []
  const contents: unknown[] = []
  for (const message of messages) {
    if (message.role === "system" && typeof message.content === "string") {
      systemParts.push(message.content)
      continue
    }
    const role = message.role === "assistant" ? "model" : "user"
    contents.push({ role, parts: partsFromMessage(message) })
  }
  if (systemParts.length === 0) {
    return { contents }
  }
  return {
    contents,
    systemInstruction: { parts: [{ text: systemParts.join("\n\n") }] },
  }
}

function responseText(raw: unknown): string | undefined {
  const root = asRecord(raw)
  const direct = root?.["text"]
  if (typeof direct === "string" && direct.trim() !== "") {
    return direct
  }
  const candidates = root?.["candidates"]
  const candidate = Array.isArray(candidates) ? asRecord(candidates[0]) : undefined
  const content = asRecord(candidate?.["content"])
  const parts = content?.["parts"]
  if (!Array.isArray(parts)) {
    return undefined
  }
  const text = parts
    .map((part) => {
      const record = asRecord(part)
      return typeof record?.["text"] === "string" ? record["text"] : ""
    })
    .join("")
  return text.trim() === "" ? undefined : text
}

export const geminiJsonHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    const payload = geminiPayloadFromMessages(kwargs.messages)
    const next: RequestKwargs = {
      ...kwargs,
      contents: payload.contents,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: llmJsonSchemaFromZod(schema),
      },
    }
    if (payload.systemInstruction !== undefined) {
      next.systemInstruction = payload.systemInstruction
    }
    return next
  },

  parseResponse(raw: unknown): unknown {
    const text = responseText(raw)
    if (text === undefined) {
      throw new JsonParseError("Gemini response has no JSON text", raw)
    }
    return parseJsonText(text, raw)
  },

  handleReask(
    kwargs: RequestKwargs,
    raw: unknown,
    error: JsonParseError | SchemaValidationError,
  ): RequestKwargs {
    const messages: Message[] = [
      ...kwargs.messages,
      { role: "assistant", content: responseText(raw) ?? "" },
      { role: "user", content: formatError(error) },
    ]
    const payload = geminiPayloadFromMessages(messages)
    const updated: RequestKwargs = {
      ...kwargs,
      messages,
      contents: payload.contents,
    }
    if (payload.systemInstruction !== undefined) {
      updated.systemInstruction = payload.systemInstruction
    }
    return updated
  },

  deltaFromChunk(raw: unknown): string {
    return responseText(raw) ?? ""
  },
}
