import type { ZodIssue } from "zod"
import type { TokenUsage } from "../usage.js"

/**
 * One chunk failed and was recorded instead of aborting the document.
 *
 * Carried on `chunks[i].error` so a caller can see which part of the document
 * failed without losing the chunks that succeeded.
 */
export class DocumentChunkError extends Error {
  readonly index: number
  readonly startIndex: number
  readonly endIndex: number
  /** The underlying failure, usually `RetryExhaustedError`. */
  readonly cause: unknown
  readonly usage: TokenUsage

  constructor(
    message: string,
    details: {
      index: number
      startIndex: number
      endIndex: number
      cause: unknown
      usage: TokenUsage
    },
  ) {
    super(message)
    this.name = "DocumentChunkError"
    this.index = details.index
    this.startIndex = details.startIndex
    this.endIndex = details.endIndex
    this.cause = details.cause
    this.usage = details.usage
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * The merged object failed the caller's schema.
 *
 * Chunk-level results were individually valid, but their combination is not —
 * for example a required field appears in no chunk, or two chunks contributed
 * values that cannot both satisfy the schema.
 */
export class DocumentMergeError extends Error {
  readonly issues: ZodIssue[]
  /** The merged-but-invalid object, kept for debugging. */
  readonly partial: unknown
  /** Chunks that failed before merging, so the two failure modes are visible. */
  readonly chunkErrors: DocumentChunkError[]

  constructor(
    message: string,
    details: {
      issues: ZodIssue[]
      partial: unknown
      chunkErrors: DocumentChunkError[]
    },
  ) {
    super(message)
    this.name = "DocumentMergeError"
    this.issues = details.issues
    this.partial = details.partial
    this.chunkErrors = details.chunkErrors
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * No chunk produced a value, so there was nothing to merge.
 *
 * Two causes, told apart by `reason`:
 *
 * - `"empty-document"`: the document was blank, so no chunk was even attempted.
 * - `"all-chunks-failed"`: chunks ran, but every one exhausted its retries.
 *
 * Both used to come back as a successful-looking `{}` whenever the schema had no
 * required field — indistinguishable from a document that genuinely held
 * nothing. `"all-chunks-failed"` is the more serious of the two: the model never
 * produced an answer, yet the tokens were spent, which is why `usage` is carried
 * here rather than dropped with the failure.
 *
 * Distinct from `DocumentMergeError`, which means chunks *did* produce values
 * but their combination failed the schema. Reporting this one as a merge failure
 * would point the caller at their schema when the real cause is upstream.
 */
export class DocumentNoDataError extends Error {
  readonly reason: "empty-document" | "all-chunks-failed"
  /** The per-chunk failures. Empty for a blank document, which runs no chunks. */
  readonly chunkErrors: DocumentChunkError[]
  /** Tokens spent before giving up, so a failed run is still accountable. */
  readonly usage: TokenUsage

  constructor(
    message: string,
    details: {
      reason: "empty-document" | "all-chunks-failed"
      chunkErrors: DocumentChunkError[]
      usage: TokenUsage
    },
  ) {
    super(message)
    this.name = "DocumentNoDataError"
    this.reason = details.reason
    this.chunkErrors = details.chunkErrors
    this.usage = details.usage
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
