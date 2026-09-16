import type { AttemptMeta, ChunkMeta } from "./types.js"

/**
 * Build the per-attempt context passed to every hook.
 *
 * `chunk` is passed only by `createDocument()`, which runs one `create()` per
 * chunk. `create()` omits it, so the key is absent rather than undefined.
 */
export function attemptMeta(
  attemptNumber: number,
  maxAttempts: number,
  isLastAttempt: boolean,
  chunk?: ChunkMeta,
): AttemptMeta {
  const meta: AttemptMeta = { attemptNumber, maxAttempts, isLastAttempt }
  if (chunk !== undefined) {
    meta.chunk = chunk
  }
  return meta
}

/**
 * Invoke a user hook without letting it break the loop.
 *
 * Telemetry must not fail a call the caller has already paid for, so a throwing
 * handler is reported and ignored rather than propagated — a hook is
 * observability, never a control-flow decision.
 */
export function safeEmit<A extends unknown[]>(
  name: string,
  handler: ((...args: A) => void) | undefined,
  args: A,
): void {
  if (handler === undefined) {
    return
  }
  try {
    handler(...args)
  } catch (error) {
    console.warn(`rubric: ${name} hook threw and was ignored`, error)
  }
}
