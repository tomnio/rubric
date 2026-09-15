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
): TokenBudgetError | undefined {
  if (tokenBudget === undefined) {
    return undefined
  }
  if (!usageAvailable) {
    return new TokenUsageUnavailableError(
      "Token budget cannot be enforced because a provider response did not include usage metadata",
      tokenBudget,
      usage,
      attempts,
    )
  }
  if (usage.totalTokens >= tokenBudget) {
    return new TokenBudgetExceeded(
      `Token budget exhausted after ${usage.totalTokens} tokens across ${attempts} attempt(s) (budget: ${tokenBudget})`,
      tokenBudget,
      usage,
      attempts,
    )
  }
  return undefined
}
