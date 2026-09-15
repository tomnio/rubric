export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  attempts: number
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, attempts: 0 }
}

/** Add two already-computed totals, e.g. across the chunks of a document. */
export function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const inputTokens = a.inputTokens + b.inputTokens
  const outputTokens = a.outputTokens + b.outputTokens
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    attempts: a.attempts + b.attempts,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Read OpenAI (`prompt_tokens`) or Anthropic (`input_tokens`) usage from a raw response. */
export function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const root = asRecord(raw)
  const usage =
    asRecord(root?.["usage"]) ??
    asRecord(asRecord(root?.["message"])?.["usage"]) ??
    asRecord(root?.["usageMetadata"])
  if (!usage) {
    return undefined
  }
  const inputTokens =
    asNumber(usage["prompt_tokens"]) ??
    asNumber(usage["input_tokens"]) ??
    asNumber(usage["promptTokenCount"])
  const outputTokens =
    asNumber(usage["completion_tokens"]) ??
    asNumber(usage["output_tokens"]) ??
    asNumber(usage["candidatesTokenCount"])
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }
}

export function addUsage(
  total: TokenUsage,
  raw: unknown,
): TokenUsage {
  const next = readUsage(raw)
  if (!next) {
    return { ...total, attempts: total.attempts + 1 }
  }
  const inputTokens = total.inputTokens + next.inputTokens
  const outputTokens = total.outputTokens + next.outputTokens
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    attempts: total.attempts + 1,
  }
}

/**
 * Whether a response carried usage metadata at all. A budget can only be
 * enforced when every attempt reported counts, so callers track this per
 * attempt and fail closed once it goes false.
 */
export function hasUsage(raw: unknown): boolean {
  return readUsage(raw) !== undefined
}

/**
 * Merge usage from a stream chunk. OpenAI sends full totals on the last
 * chunk; Anthropic sends input on message_start and cumulative output on
 * message_delta. Do not increment attempts per chunk.
 */
export function mergeChunkUsage(total: TokenUsage, raw: unknown): TokenUsage {
  const next = readUsage(raw)
  if (!next) {
    return total
  }
  const inputTokens = Math.max(total.inputTokens, next.inputTokens)
  const outputTokens = Math.max(total.outputTokens, next.outputTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    attempts: total.attempts,
  }
}

export function finishStreamUsage(total: TokenUsage): TokenUsage {
  return {
    ...total,
    attempts: 1,
    totalTokens: total.inputTokens + total.outputTokens,
  }
}
