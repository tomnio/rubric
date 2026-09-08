import type { ZodIssue } from "zod"

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

  constructor(
    message: string,
    attempts: number,
    lastError: JsonParseError | SchemaValidationError,
  ) {
    super(message)
    this.name = "RetryExhaustedError"
    this.attempts = attempts
    this.lastError = lastError
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
