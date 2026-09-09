import type { ZodIssue } from "zod"

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
