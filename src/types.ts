import type { z } from "zod"

/** Request encoding used to send the schema and read JSON back. */
export type Mode = "TOOLS" | "JSON_SCHEMA" | "MD_JSON"

export type Message = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_call_id?: string
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
