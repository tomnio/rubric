/**
 * Combine the caller's `signal` with a wall-clock `timeout` into one signal.
 *
 * The returned signal aborts on whichever comes first: the caller aborting, or
 * the timeout elapsing. Every existing consumer already understands an
 * `AbortSignal`, so a timeout needs no new plumbing — it is just a signal that
 * expires on its own.
 *
 * `AbortSignal.timeout()` keeps its timer unref'd, so a call that finishes
 * early leaves nothing holding the event loop open.
 *
 * Returns `undefined` when neither input is present, so callers keep passing
 * `undefined` rather than an inert signal that the SDK would treat as a live
 * abort source.
 */
export function combineSignal(
  signal: AbortSignal | undefined,
  timeout: number | undefined,
): AbortSignal | undefined {
  if (timeout === undefined) {
    return signal
  }
  const deadline = AbortSignal.timeout(timeout)
  if (signal === undefined) {
    return deadline
  }
  return AbortSignal.any([signal, deadline])
}
