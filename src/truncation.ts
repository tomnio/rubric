// Local copy of the record guard, as in usage.ts: this module reads raw
// provider shapes and must not depend on a mode handler to do it.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

/**
 * The provider's own spelling of "I stopped at the output token limit".
 *
 * Kept as literals rather than normalized to a boolean so the thrown error can
 * quote what the provider actually said: OpenAI and its compatible gateways
 * send `finish_reason: "length"`, Anthropic sends `stop_reason: "max_tokens"`,
 * and Gemini sends `finishReason: "MAX_TOKENS"`. Some OpenAI-compatible servers
 * spell it `"max_tokens"` in the OpenAI slot, so all three markers are accepted
 * in any slot — a field carrying one of them means truncation wherever it sits.
 */
const TRUNCATION_MARKERS: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "MAX_TOKENS",
])

/**
 * The provider's truncation marker for a response, or `undefined` when the
 * response was not cut off.
 *
 * One reader for every wire format, the way `readUsage()` reads usage from
 * OpenAI, Anthropic, and Gemini shapes in one place: the marker lives in a
 * different field per provider, and a caller of `extract()` should not have to
 * know which mode it used to find out whether the answer was cut short.
 */
export function truncationReason(raw: unknown): string | undefined {
  const root = asRecord(raw)
  if (!root) {
    return undefined
  }

  // OpenAI, and gateways that copy its shape: choices[0].finish_reason.
  const choices = root["choices"]
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  const openai = choice?.["finish_reason"]
  if (typeof openai === "string" && TRUNCATION_MARKERS.has(openai)) {
    return openai
  }

  // Anthropic: a top-level stop_reason.
  const anthropic = root["stop_reason"]
  if (typeof anthropic === "string" && TRUNCATION_MARKERS.has(anthropic)) {
    return anthropic
  }

  // Gemini: candidates[0].finishReason.
  const candidates = root["candidates"]
  const candidate = Array.isArray(candidates)
    ? asRecord(candidates[0])
    : undefined
  const gemini = candidate?.["finishReason"]
  if (typeof gemini === "string" && TRUNCATION_MARKERS.has(gemini)) {
    return gemini
  }

  return undefined
}
