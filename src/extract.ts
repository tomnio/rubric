import type { z } from "zod"
import { assertMaxRetries, assertTokenBudget, budgetError } from "./budget.js"
import { runWithContext } from "./context.js"
import {
  JsonParseError,
  RetryExhaustedError,
  SchemaValidationError,
} from "./errors.js"
import { attemptMeta, safeEmit } from "./hooks.js"
import { handlerFor } from "./modes/registry.js"
import { applyRequestExtras, mergeSamplingExtras } from "./request.js"
import { coerceParsedValue } from "./schema.js"
import type { CreateParams, Hooks, LLMClient, Mode, WrapOptions } from "./types.js"
import { addUsage, emptyUsage, hasUsage } from "./usage.js"

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_MODE: Mode = "TOOLS"

export async function extract<T extends z.ZodType>(
  client: LLMClient,
  params: CreateParams<T>,
  defaults?: WrapOptions,
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

  while (attempts < attemptsAllowed) {
    attempts += 1
    const retriesLeft = attempts < attemptsAllowed
    safeEmit(
      "onRequest",
      hooks.onRequest,
      [kwargs, attemptMeta(attempts, attemptsAllowed, !retriesLeft)],
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
        [err, attemptMeta(attempts, attemptsAllowed, true)],
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
        [usage, attemptMeta(attempts, attemptsAllowed, true)],
      )
      safeEmit(
        "onSuccess",
        hooks.onSuccess,
        [parsed.data, attemptMeta(attempts, attemptsAllowed, true)],
      )
      return parsed.data
    } catch (err) {
      if (!(err instanceof JsonParseError || err instanceof SchemaValidationError)) {
        throw err
      }
      lastError = err
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
        [err, attemptMeta(attempts, attemptsAllowed, isLast)],
      )
      if (overBudget !== undefined) {
        safeEmit(
          "onUsage",
          hooks.onUsage,
          [usage, attemptMeta(attempts, attemptsAllowed, true)],
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
    [usage, attemptMeta(attempts, attemptsAllowed, true)],
  )
  throw new RetryExhaustedError(
    `Failed after ${attempts} attempt(s)`,
    attempts,
    lastError,
    usage,
  )
}
