import type { z } from "zod"
import type { JsonParseError, SchemaValidationError } from "./errors.js"
import type { TokenUsage } from "./usage.js"

/** Request encoding used to send the schema and read JSON back. */
export type Mode =
  | "TOOLS"
  | "JSON_SCHEMA"
  | "MD_JSON"
  | "ANTHROPIC_TOOLS"
  | "GEMINI_JSON"

export type CallOptions = {
  signal?: AbortSignal
}

/** Minimal chat-completions surface. Tests inject a fake; a live adapter comes later. */
export type LLMClient = {
  chatCompletionsCreate(
    kwargs: RequestKwargs,
    options?: CallOptions,
  ): Promise<unknown>
  chatCompletionsStream?: (
    kwargs: RequestKwargs,
    options?: CallOptions,
  ) => AsyncIterable<unknown>
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
  stream_options?: unknown
  temperature?: number
  top_p?: number
  contents?: unknown
  config?: unknown
  systemInstruction?: unknown
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

export type AnthropicImageBlock = {
  type: "image"
  source:
    | { type: "url"; url: string }
    | { type: "base64"; media_type: string; data: string }
}

export type ContentBlock =
  | { type: "text"; text: string }
  | ImageUrlBlock
  | AnthropicImageBlock
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

/**
 * Where a hook event came from when one call fanned out into many.
 *
 * Populated only by `createDocument()`, which runs `create()` once per chunk.
 * `create()` leaves it undefined, because a single call is its own context.
 */
export type ChunkMeta = {
  /** 0-based position in document order. */
  index: number
  /** Absolute offset of this chunk's window in the document. */
  startIndex: number
  endIndex: number
  /** How many chunks the document was split into, so progress is computable. */
  total: number
}

/** Per-attempt context passed to every hook as its second argument. */
export type AttemptMeta = {
  /** 1-based index of the attempt that just ran. */
  attemptNumber: number
  /** Total attempts this call may make (`maxRetries + 1`). */
  maxAttempts: number
  /**
   * True when no further attempt will be made: either the attempts are spent,
   * or a guardrail (token budget) stopped the loop early.
   */
  isLastAttempt: boolean
  /**
   * Which chunk this attempt belongs to. Present only during
   * `createDocument()`, where one document becomes many `create()` calls;
   * absent for a plain `create()`.
   *
   * `attemptNumber` counts attempts *within this chunk* and resets at each
   * chunk boundary, so `chunk.index` — not a running count of hook calls — is
   * what identifies the chunk.
   */
  chunk?: ChunkMeta
}

/**
 * Observability callbacks. A hook never affects the loop: a throwing handler is
 * reported and ignored (see `safeEmit`), because telemetry must not fail a call
 * the caller has already paid for.
 */
export type Hooks = {
  onRequest?: (kwargs: RequestKwargs, meta: AttemptMeta) => void
  /**
   * The provider call itself threw: network, auth, rate limit, SDK bug. These
   * are not retried, so this always carries `isLastAttempt: true`.
   */
  onError?: (error: unknown, meta: AttemptMeta) => void
  /** Retryable failure: no JSON, or JSON that failed schema validation. */
  onParseError?: (
    error: JsonParseError | SchemaValidationError,
    meta: AttemptMeta,
  ) => void
  onSuccess?: (value: unknown, meta: AttemptMeta) => void
  /** Totals across every attempt in this create() call, including reasks. */
  onUsage?: (usage: TokenUsage, meta: AttemptMeta) => void
}

export type SamplingExtras = {
  temperature?: number
  max_tokens?: number
  top_p?: number
}

export type WrapOptions = SamplingExtras & {
  /** Default mode for create(). Default: "TOOLS" */
  mode?: Mode
  /** Extra attempts after the first. Default: 3 */
  maxRetries?: number
  /**
   * Default cumulative token budget for create(). When the total across
   * attempts reaches this number, the loop stops instead of retrying.
   */
  tokenBudget?: number
  hooks?: Hooks
}

export type CreateParams<T extends z.ZodType> = SamplingExtras & {
  model: string
  messages: Message[]
  schema: T
  maxRetries?: number
  mode?: Mode
  hooks?: Hooks
  signal?: AbortSignal
  /**
   * Cumulative token budget for this call. When the total across attempts
   * reaches this number, the loop stops instead of retrying. A response that
   * already validated is still returned; the budget only blocks the next
   * attempt. Requires usage metadata from the provider: if a response omits
   * it, the call fails with TokenUsageUnavailableError rather than retrying
   * blind. Not supported by createPartial() / createIterable().
   */
  tokenBudget?: number
  /**
   * Source text for `cited()` schemas. Quotes must appear in this text.
   * Ignored by schemas that do not use `cited()`.
   */
  context?: string
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
