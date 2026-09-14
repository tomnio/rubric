import type { CreateParams, RequestKwargs } from "./types.js"

/** Copy user sampling fields onto kwargs after the mode handler runs. */
export function applyRequestExtras(
  kwargs: RequestKwargs,
  params: Pick<CreateParams<never>, "temperature" | "max_tokens" | "top_p">,
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
