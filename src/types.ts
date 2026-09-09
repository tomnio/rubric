import type { z } from "zod"
import type { JsonParseError, SchemaValidationError } from "./errors.ts"

/** Request encoding used to send the schema and read JSON back. */
export type Mode = "TOOLS" | "JSON_SCHEMA" | "MD_JSON" | "ANTHROPIC_TOOLS"

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
  max_tokens?: number
  system?: string
}

export type ToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result"
      tool_use_id: string
      content: string
      is_error?: boolean
    }

export type Message = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null | ContentBlock[]
  tool_call_id?: string
  tool_calls?: ToolCall[]
}

export type Hooks = {
  onRequest?: (kwargs: RequestKwargs) => void
  onParseError?: (error: JsonParseError | SchemaValidationError) => void
  onSuccess?: (value: unknown) => void
}

export type WrapOptions = {
  /** Default mode for create(). Default: "TOOLS" */
  mode?: Mode
  /** Extra attempts after the first. Default: 3 */
  maxRetries?: number
  hooks?: Hooks
}

export type CreateParams<T extends z.ZodType> = {
  model: string
  messages: Message[]
  schema: T
  maxRetries?: number
  mode?: Mode
  hooks?: Hooks
}

export type RubricClient = {
  create<T extends z.ZodType>(params: CreateParams<T>): Promise<z.infer<T>>
}
