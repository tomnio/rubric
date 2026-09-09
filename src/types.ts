import type { z } from "zod"

/** Request encoding used to send the schema and read JSON back. */
export type Mode = "TOOLS" | "JSON_SCHEMA" | "MD_JSON"

/** Minimal chat-completions surface. Tests inject a fake; a live adapter comes later. */
export type LLMClient = {
  chatCompletionsCreate(kwargs: RequestKwargs): Promise<unknown>
}

/** Arguments passed to the LLM client. Modes add tools / response_format. */
export type RequestKwargs = {
  model: string
  messages: Message[]
  tools?: unknown
  tool_choice?: unknown
  response_format?: unknown
}

export type ToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type Message = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export type WrapOptions = {
  /** Default mode for create(). Default: "TOOLS" */
  mode?: Mode
  /** Extra attempts after the first. Default: 3 */
  maxRetries?: number
}

export type CreateParams<T extends z.ZodType> = {
  model: string
  messages: Message[]
  schema: T
  maxRetries?: number
  mode?: Mode
}

export type RubricClient = {
  create<T extends z.ZodType>(params: CreateParams<T>): Promise<z.infer<T>>
}
