import type { z } from "zod"
import type { JsonParseError, SchemaValidationError } from "./errors.js"
import type { TokenUsage } from "./usage.js"

/** Request encoding used to send the schema and read JSON back. */
export type Mode = "TOOLS" | "JSON_SCHEMA" | "MD_JSON" | "ANTHROPIC_TOOLS"

/** Minimal chat-completions surface. Tests inject a fake; a live adapter comes later. */
export type LLMClient = {
  chatCompletionsCreate(kwargs: RequestKwargs): Promise<unknown>
  chatCompletionsStream?: (kwargs: RequestKwargs) => AsyncIterable<unknown>
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
  stream?: boolean
}

export type ToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ImageUrlBlock = {
  type: "image_url"
  image_url: {
    url: string
    detail?: "auto" | "low" | "high"
  }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | ImageUrlBlock
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
  /** Totals across every attempt in this create() call, including reasks. */
  onUsage?: (usage: TokenUsage) => void
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

export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export type RubricClient = {
  create<T extends z.ZodType>(params: CreateParams<T>): Promise<z.infer<T>>
  createPartial<T extends z.ZodType>(
    params: CreateParams<T>,
  ): AsyncIterable<DeepPartial<z.infer<T>>>
  /** Stream complete items. `schema` is the item type, not an array. */
  createIterable<T extends z.ZodType>(
    params: CreateParams<T>,
  ): AsyncIterable<z.infer<T>>
}
