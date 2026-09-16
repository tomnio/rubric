import {
  TokenBudgetExceeded,
  TokenUsageUnavailableError,
  type TokenBudgetError,
} from "./errors.js"
import type { TokenUsage } from "./usage.js"

/**
 * Validate a token budget before the first provider call.
 *
 * Rejecting bad configuration up front means a typo cannot silently disable
 * the guardrail after the caller has already paid for a request.
 */
export function assertTokenBudget(
  tokenBudget: number | undefined,
): number | undefined {
  if (tokenBudget === undefined) {
    return undefined
  }
  if (!Number.isInteger(tokenBudget)) {
    throw new TypeError("tokenBudget must be a positive integer")
  }
  if (tokenBudget <= 0) {
    throw new RangeError("tokenBudget must be greater than zero")
  }
  return tokenBudget
}

/**
 * Validate a retry count before the first provider call.
 *
 * `maxRetries` is user-supplied and easy to compute wrong (`config.retries - 1`,
 * a value parsed from env). Left unchecked, a negative or `NaN` value makes the
 * loop run zero times and throw `RetryExhaustedError` for a call that never
 * happened, and a fractional value silently rounds up — `0.5` spends two
 * attempts, more than written. Reject both up front, as `assertTokenBudget`
 * does, so the mistake names itself instead of looking like a model failure.
 */
export function assertMaxRetries(
  maxRetries: number | undefined,
): number | undefined {
  if (maxRetries === undefined) {
    return undefined
  }
  if (!Number.isInteger(maxRetries)) {
    throw new TypeError("maxRetries must be a non-negative integer")
  }
  if (maxRetries < 0) {
    throw new RangeError("maxRetries must not be negative")
  }
  return maxRetries
}

/**
 * Largest delay `AbortSignal.timeout()` handles correctly.
 *
 * Beyond this it does **not** throw: it prints a stderr warning and fires after
 * 1 ms. A caller who wrote `timeout: 3_000_000_000` would get every call
 * aborted instantly, so the value is rejected here instead of silently
 * inverted. 2^31 - 1 ms is about 24.8 days, far past any real call.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Validate a wall-clock timeout before the first provider call.
 *
 * Same reasoning as `assertTokenBudget`: a typo must name itself rather than
 * disable the guardrail after the caller has already paid for a request.
 */
export function assertTimeout(
  timeout: number | undefined,
): number | undefined {
  if (timeout === undefined) {
    return undefined
  }
  if (!Number.isInteger(timeout)) {
    throw new TypeError("timeout must be a positive integer (milliseconds)")
  }
  if (timeout <= 0) {
    throw new RangeError("timeout must be greater than zero")
  }
  if (timeout > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `timeout must be at most ${MAX_TIMEOUT_MS} ms, because AbortSignal.timeout() silently fires after 1 ms beyond that`,
    )
  }
  return timeout
}

/**
 * Reject a budget on a streaming call.
 *
 * A stream has no reask to guard, and its usage arrives incrementally, so a
 * budget could not be enforced before the call that spends it. Reject it
 * rather than accept a setting that silently does nothing.
 */
export function rejectTokenBudgetForStream(
  tokenBudget: number | undefined,
  caller: string,
): void {
  if (assertTokenBudget(tokenBudget) !== undefined) {
    throw new Error(`tokenBudget is not supported by ${caller}()`)
  }
}

/**
 * Reject a timeout on a streaming call.
 *
 * A stream's whole point is to emit before it finishes, so "the deadline
 * passed" has no single moment to report: aborting mid-stream would either
 * discard items the caller already received or end the iteration without
 * saying why. Rejected rather than accepted with undefined semantics.
 */
export function rejectTimeoutForStream(
  timeout: number | undefined,
  caller: string,
): void {
  if (assertTimeout(timeout) !== undefined) {
    throw new Error(`timeout is not supported by ${caller}()`)
  }
}

/**
 * Decide whether the retry loop may spend another attempt.
 *
 * Only called on the failure path, so a response that arrives valid is still
 * returned even if it pushed the total past the budget. The guardrail stops
 * the *next* call, not the answer in hand.
 *
 * Fails closed when usage is missing: without token counts the budget cannot
 * be enforced, so retrying blind would silently defeat it.
 */
export function budgetError(
  tokenBudget: number | undefined,
  usageAvailable: boolean,
  usage: TokenUsage,
  attempts: number,
  /**
   * What the budget covers, used only in the message. `createDocument()` passes
   * "Document token budget" so a failure is not read as one chunk's problem;
   * the numbers in the error already refer to the right scope either way.
   */
  label = "Token budget",
): TokenBudgetError | undefined {
  if (tokenBudget === undefined) {
    return undefined
  }
  if (!usageAvailable) {
    return new TokenUsageUnavailableError(
      `${label} cannot be enforced because a provider response did not include usage metadata`,
      tokenBudget,
      usage,
      attempts,
    )
  }
  if (usage.totalTokens >= tokenBudget) {
    return new TokenBudgetExceeded(
      `${label} exhausted after ${usage.totalTokens} tokens across ${attempts} attempt(s) (budget: ${tokenBudget})`,
      tokenBudget,
      usage,
      attempts,
    )
  }
  return undefined
}
