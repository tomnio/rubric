import type { RequestKwargs, SamplingExtras } from "./types.js"

/** create() fields override wrap() defaults. Omitted keys stay unset. */
export function mergeSamplingExtras(
  defaults?: SamplingExtras,
  params?: SamplingExtras,
): SamplingExtras {
  const extras: SamplingExtras = {}
  const temperature = params?.temperature ?? defaults?.temperature
  const maxTokens = params?.max_tokens ?? defaults?.max_tokens
  const topP = params?.top_p ?? defaults?.top_p
  if (temperature !== undefined) {
    extras.temperature = temperature
  }
  if (maxTokens !== undefined) {
    extras.max_tokens = maxTokens
  }
  if (topP !== undefined) {
    extras.top_p = topP
  }
  return extras
}

/** Copy user sampling fields onto kwargs after the mode handler runs. */
export function applyRequestExtras(
  kwargs: RequestKwargs,
  params: SamplingExtras,
): RequestKwargs {
  const next: RequestKwargs = { ...kwargs }
  if (params.temperature !== undefined) {
    next.temperature = params.temperature
  }
  if (params.max_tokens !== undefined) {
    next.max_tokens = params.max_tokens
  }
  if (params.top_p !== undefined) {
    next.top_p = params.top_p
  }
  return next
}
