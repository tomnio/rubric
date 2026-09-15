import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-call state that validators read from the inside.
 *
 * A Zod refinement gets only the value and a context object, so anything else
 * it needs (the citation source, the enclosing model) has to travel beside the
 * parse. `AsyncLocalStorage` keeps that state per async context: concurrent
 * `create()` calls cannot observe each other's values, and an `await` inside a
 * validator does not leak the store into unrelated work.
 */
export type ValidationContext = {
  /** Source text for `cited()` schemas. */
  citation?: string | undefined
  /** Model of the enclosing create(), used as the judge's default. */
  model?: string | undefined
}

const storage = new AsyncLocalStorage<ValidationContext>()

/** Run `fn` with `context` visible to every validator it reaches. */
export function runWithContext<T>(context: ValidationContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** The context of the current async call, or an empty one outside `create()`. */
export function currentContext(): ValidationContext {
  return storage.getStore() ?? {}
}
