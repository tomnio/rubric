import type { ZodIssue } from "zod"
import type { TokenUsage } from "../usage.js"
import type { ChunkOutcome } from "./index.js"

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

/** One value a chunk reported for a conflicting field. */
export type ConflictValue = {
  value: unknown
  /** Absolute offset of the window the value was read from. */
  startIndex: number
  endIndex: number
}

/** A field two or more chunks reported with values that are not equal. */
export type ConflictEntry = {
  /** The field that disagreed, or `"(root)"` for a scalar root. */
  key: string
  /** Every non-null value reported, in chunk order. */
  values: ConflictValue[]
}

/**
 * Two chunks reported different values for the same field, under
 * `onConflict: "error"`.
 *
 * The default merge takes the first value and silently drops the rest. That is
 * usually what a caller wants — chunk order roughly follows document order —
 * but it can hide a real disagreement: the document may say one thing in one
 * place and another later, and "first wins" reports neither to the caller.
 * `onConflict: "error"` turns that silent choice into a failure.
 *
 * Equality is the same structural comparison array dedupe uses, so two chunks
 * that agree (the common case, where overlapping windows read the same text)
 * are not a conflict; only genuinely different values are.
 */
export class DocumentConflictError extends Error {
  /** Every conflicting field, in the order the merge visited them. */
  readonly conflicts: ConflictEntry[]
  /** Chunks that failed before merging, if any. */
  readonly chunkErrors: DocumentChunkError[]

  constructor(
    message: string,
    details: {
      conflicts: ConflictEntry[]
      chunkErrors: DocumentChunkError[]
    },
  ) {
    super(message)
    this.name = "DocumentConflictError"
    this.conflicts = details.conflicts
    this.chunkErrors = details.chunkErrors
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

/**
 * Why the document stopped before every chunk had run. The original error is
 * on `cause`: a `TimeoutError` (deadline), an `AbortError` (caller signal),
 * a `TokenBudgetExceeded`, or a `TokenUsageUnavailableError`.
 */
export type InterruptReason =
  | "timeout"
  | "aborted"
  | "token-budget"
  | "usage-unavailable"

/**
 * The document was cut short mid-run by a timeout, an abort, or the document
 * budget — and everything extracted before the cut is carried on the error
 * instead of being dropped.
 *
 * The caller paid for every completed chunk, so the error carries what that
 * money bought:
 *
 * - `partial` — the completed chunks merged as far as they go. This is a
 *   best-effort value, **not** validated against the schema (an interrupted
 *   document usually cannot satisfy it) and possibly incomplete: fields no
 *   finished chunk saw are simply absent. Treat it as provisional data, never
 *   as the final result.
 * - `chunks` — per-chunk provenance up to the interruption, in document order,
 *   including chunks that failed and were skipped.
 * - `usage` — the document-wide spend at the moment of the cut.
 *
 * The original interrupting error stays on `cause`, so code that checked for
 * `TokenBudgetExceeded` or `TimeoutError` before keeps working one level down.
 * Distinct from `DocumentChunkError`, which is one chunk failing while the
 * document carries on.
 */
export class DocumentInterruptedError extends Error {
  /** What stopped the run. */
  readonly reason: InterruptReason
  /** Completed chunks merged best-effort; `undefined` when no chunk finished. */
  readonly partial: unknown
  /** Provenance for everything that ran before the cut, in document order. */
  readonly chunks: ChunkOutcome[]
  /** Document-wide token spend when the run was cut. */
  readonly usage: TokenUsage

  constructor(
    message: string,
    details: {
      reason: InterruptReason
      partial: unknown
      chunks: ChunkOutcome[]
      usage: TokenUsage
      cause: unknown
    },
  ) {
    super(message)
    this.name = "DocumentInterruptedError"
    this.reason = details.reason
    this.partial = details.partial
    this.chunks = details.chunks
    this.usage = details.usage
    this.cause = details.cause
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
