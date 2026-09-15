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
