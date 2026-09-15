import type { z } from "zod"
import { assertMaxRetries, assertTokenBudget, budgetError } from "./budget.js"
import { runWithContext } from "./context.js"
import {
  JsonParseError,
  OutputTruncatedError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.js"
import { attemptMeta, safeEmit } from "./hooks.js"
import { handlerFor } from "./modes/registry.js"
import { applyRequestExtras, mergeSamplingExtras } from "./request.js"
import { coerceParsedValue } from "./schema.js"
import { truncationReason } from "./truncation.js"
import type {
  AttemptMeta,
  ChunkMeta,
  CreateParams,
  Hooks,
  LLMClient,
  Mode,
  WrapOptions,
} from "./types.js"
import { addUsage, emptyUsage, hasUsage } from "./usage.js"

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MODE: Mode = "TOOLS"

export async function extract<T extends z.ZodType>(
  client: LLMClient,
  params: CreateParams<T>,
  defaults?: WrapOptions,
  /**
   * Set only by `createDocument()`, which calls this once per chunk. Threaded
   * into every hook's `AttemptMeta` so a handler can tell which chunk it is
   * looking at; `create()` leaves it undefined.
   */
  chunk?: ChunkMeta,
): Promise<z.infer<T>> {
  const mode = params.mode ?? defaults?.mode ?? DEFAULT_MODE
  const maxRetries =
    assertMaxRetries(params.maxRetries ?? defaults?.maxRetries) ??
    DEFAULT_MAX_RETRIES
  const tokenBudget = assertTokenBudget(
    params.tokenBudget ?? defaults?.tokenBudget,
  )
  const hooks: Hooks = { ...defaults?.hooks, ...params.hooks }
  const attemptsAllowed = maxRetries + 1
  const handler = handlerFor(mode)
  let kwargs = applyRequestExtras(
    handler.prepareRequest(params.schema, {
      model: params.model,
      messages: params.messages,
    }),
    mergeSamplingExtras(defaults, params),
  )
  let lastError: JsonParseError | SchemaValidationError | undefined
  let attempts = 0
  let usage = emptyUsage()
  // Stays true only while every attempt reported usage. The budget is
  // unenforceable the moment one response omits it.
  let usageAvailable = true

  // Every hook below belongs to the same chunk (when there is one), so bind it
  // once instead of threading it through eight call sites.
  const meta = (attempt: number, max: number, last: boolean): AttemptMeta =>
    attemptMeta(attempt, max, last, chunk)

  while (attempts < attemptsAllowed) {
    attempts += 1
    const retriesLeft = attempts < attemptsAllowed
    safeEmit(
      "onRequest",
      hooks.onRequest,
      [kwargs, meta(attempts, attemptsAllowed,!retriesLeft)],
    )
    params.signal?.throwIfAborted()

    let raw: unknown
    try {
      raw = await client.chatCompletionsCreate(
        kwargs,
        params.signal ? { signal: params.signal } : undefined,
      )
    } catch (err) {
      // Provider / SDK failure. Not retried, so this attempt is the last one.
      safeEmit(
        "onError",
        hooks.onError,
        [err, meta(attempts, attemptsAllowed,true)],
      )
      throw err
    }

    usage = addUsage(usage, raw)
    usageAvailable = usageAvailable && hasUsage(raw)

    try {
      const json = coerceParsedValue(params.schema, handler.parseResponse(raw))
      // Includes .refine() / .superRefine(); those issues go into reask text.
      // safeParseAsync, not safeParse: llmRefine() refinements are async, and
      // Zod throws if an async refinement runs during a synchronous parse.
      // runWithContext carries the citation source and model to validators
      // without exposing them on the schema (Zod has no validation_context).
      const parsed = await runWithContext(
        { citation: params.context, model: params.model },
        () => params.schema.safeParseAsync(json),
      )
      if (!parsed.success) {
        throw new SchemaValidationError(
          "Output failed schema validation",
          parsed.error.issues,
        )
      }
      safeEmit(
        "onUsage",
        hooks.onUsage,
        [usage, meta(attempts, attemptsAllowed,true)],
      )
      safeEmit(
        "onSuccess",
        hooks.onSuccess,
        [parsed.data, meta(attempts, attemptsAllowed,true)],
      )
      return parsed.data
    } catch (err) {
      if (!(err instanceof JsonParseError || err instanceof SchemaValidationError)) {
        throw err
      }
      lastError = err
      // The provider hit its output cap. Reasking would resend the same
      // max_tokens and be cut in the same place, so the loop stops here and
      // names the real cause instead of blaming the JSON. Checked after the
      // parse above, so a response that validated despite the marker is still
      // returned — the flag means "the model was stopped", not "the answer is
      // unusable".
      const truncated = truncationReason(raw)
      if (truncated !== undefined) {
        safeEmit(
          "onParseError",
          hooks.onParseError,
          [err, meta(attempts, attemptsAllowed, true)],
        )
        safeEmit(
          "onUsage",
          hooks.onUsage,
          [usage, meta(attempts, attemptsAllowed, true)],
        )
        throw new OutputTruncatedError(
          `Output was cut off by the provider's token limit after ${attempts} attempt(s) (${truncated}). Raise max_tokens, or extract a smaller schema.`,
          {
            reason: truncated,
            raw,
            attempts,
            usage,
            cause: err,
          },
        )
      }
      // Checked only on the failure path: a valid response that pushed the
      // total past the budget was already returned above. This stops the next
      // call, not the answer in hand.
      const overBudget = retriesLeft
        ? budgetError(tokenBudget, usageAvailable, usage, attempts)
        : undefined
      // A guardrail that stops the loop makes this the last attempt, even when
      // attempts remain.
      const isLast = !retriesLeft || overBudget !== undefined
      safeEmit(
        "onParseError",
        hooks.onParseError,
        [err, meta(attempts, attemptsAllowed,isLast)],
      )
      if (overBudget !== undefined) {
        safeEmit(
          "onUsage",
          hooks.onUsage,
          [usage, meta(attempts, attemptsAllowed,true)],
        )
        throw overBudget
      }
      if (!retriesLeft) {
        break
      }
      kwargs = handler.handleReask(kwargs, raw, err)
    }
  }

  safeEmit(
    "onUsage",
    hooks.onUsage,
    [usage, meta(attempts, attemptsAllowed,true)],
  )
  throw new RetryExhaustedError(
    `Failed after ${attempts} attempt(s)`,
    attempts,
    lastError,
    usage,
  )
}
