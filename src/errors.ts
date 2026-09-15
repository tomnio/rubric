import type { ZodIssue } from "zod"
import type { TokenUsage } from "./usage.js"

/** Short error text attached to the next LLM request, including refine issues. */
export function formatError(
  error: JsonParseError | SchemaValidationError,
): string {
  if (error instanceof SchemaValidationError) {
    const lines = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
      return `- ${path}: ${issue.message}`
    })
    return [
      "The previous output failed schema validation:",
      ...lines,
      "Fix the JSON and try again.",
    ].join("\n")
  }
  return [
    "The previous output was not valid JSON.",
    "Return a single JSON object that matches the schema.",
  ].join("\n")
}

/** Thrown when the model response has no JSON, or JSON.parse fails. */
export class JsonParseError extends Error {
  readonly raw: unknown

  constructor(message: string, raw: unknown) {
    super(message)
    this.name = "JsonParseError"
    this.raw = raw
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Thrown when JSON parsed but the value failed schema.safeParse. */
export class SchemaValidationError extends Error {
  readonly issues: ZodIssue[]

  constructor(message: string, issues: ZodIssue[]) {
    super(message)
    this.name = "SchemaValidationError"
    this.issues = issues
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Thrown by create() when retryable failures exhaust maxRetries. */
export class RetryExhaustedError extends Error {
  readonly attempts: number
  readonly lastError: JsonParseError | SchemaValidationError
  readonly usage: TokenUsage | undefined

  constructor(
    message: string,
    attempts: number,
    lastError: JsonParseError | SchemaValidationError,
    usage?: TokenUsage,
  ) {
    super(message)
    this.name = "RetryExhaustedError"
    this.attempts = attempts
    this.lastError = lastError
    this.usage = usage
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Base for token budget failures. Carries the usage snapshot at the moment the
 * guardrail fired, so callers can log what was spent before the abort.
 */
export class TokenBudgetError extends Error {
  readonly budget: number
  readonly usage: TokenUsage
  readonly attempts: number

  constructor(
    message: string,
    budget: number,
    usage: TokenUsage,
    attempts: number,
  ) {
    super(message)
    this.name = "TokenBudgetError"
    this.budget = budget
    this.usage = usage
    this.attempts = attempts
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Thrown before a retry that would continue at an exhausted token budget.
 * A response that arrives valid is still returned: the guardrail only stops
 * the loop from spending more on another attempt.
 */
export class TokenBudgetExceeded extends TokenBudgetError {
  constructor(
    message: string,
    budget: number,
    usage: TokenUsage,
    attempts: number,
  ) {
    super(message, budget, usage, attempts)
    this.name = "TokenBudgetExceeded"
  }
}

/**
 * Thrown when a budget is set but a provider response omitted usage metadata,
 * so the budget cannot be enforced. Fail closed instead of retrying blind.
 */
export class TokenUsageUnavailableError extends TokenBudgetError {
  constructor(
    message: string,
    budget: number,
    usage: TokenUsage,
    attempts: number,
  ) {
    super(message, budget, usage, attempts)
    this.name = "TokenUsageUnavailableError"
  }
}
