import type { AttemptMeta } from "./types.js"

/** Build the per-attempt context passed to every hook. */
export function attemptMeta(
  attemptNumber: number,
  maxAttempts: number,
  isLastAttempt: boolean,
): AttemptMeta {
  return { attemptNumber, maxAttempts, isLastAttempt }
}

/**
 * Invoke a user hook without letting it break the loop.
 *
 * Telemetry must not fail a call the caller has already paid for, so a throwing
 * handler is reported and ignored rather than propagated. This mirrors Python
 * Instructor, which warns on a failing handler instead of aborting.
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
