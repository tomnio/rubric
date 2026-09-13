export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  attempts: number
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, attempts: 0 }
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
  const usage = asRecord(asRecord(raw)?.["usage"])
  if (!usage) {
    return undefined
  }
  const inputTokens =
    asNumber(usage["prompt_tokens"]) ?? asNumber(usage["input_tokens"])
  const outputTokens =
    asNumber(usage["completion_tokens"]) ?? asNumber(usage["output_tokens"])
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
