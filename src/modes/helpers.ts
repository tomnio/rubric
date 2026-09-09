import { formatError, JsonParseError, type SchemaValidationError } from "../errors.ts"
import type { Message, RequestKwargs, ToolCall } from "../types.ts"

export const EXTRACT_NAME = "extract"

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

export function choiceDelta(raw: unknown): Record<string, unknown> | undefined {
  const root = asRecord(raw)
  const choices = root?.["choices"]
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  return asRecord(choice?.["delta"])
}

export function openaiContentDelta(raw: unknown): string {
  const content = choiceDelta(raw)?.["content"]
  return typeof content === "string" ? content : ""
}

export function openaiToolArgsDelta(raw: unknown): string {
  const delta = choiceDelta(raw)
  const toolCalls = delta?.["tool_calls"]
  const call = Array.isArray(toolCalls) ? asRecord(toolCalls[0]) : undefined
  const args = asRecord(call?.["function"])?.["arguments"]
  return typeof args === "string" ? args : ""
}

export function choiceMessage(raw: unknown): Record<string, unknown> | undefined {
  const root = asRecord(raw)
  const choices = root?.["choices"]
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  return asRecord(choice?.["message"])
}

export function assistantMessageFromRaw(raw: unknown): Message {
  const message = choiceMessage(raw)
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

export function readToolCalls(value: unknown): ToolCall[] | undefined {
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

export function parseJsonText(
  text: string,
  raw: unknown,
  message = "Message content is not valid JSON",
): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new JsonParseError(message, raw)
  }
}

/** Reask by appending the assistant output and a user error message. */
export function reaskWithUserMessage(
  kwargs: RequestKwargs,
  raw: unknown,
  error: JsonParseError | SchemaValidationError,
): RequestKwargs {
  return {
    ...kwargs,
    messages: [
      ...kwargs.messages,
      assistantMessageFromRaw(raw),
      { role: "user", content: formatError(error) },
    ],
  }
}
