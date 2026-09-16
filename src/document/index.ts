import type { z } from "zod"
import {
  assertMaxRetries,
  assertTimeout,
  assertTokenBudget,
  budgetError,
} from "../budget.js"
import { toLLMClient, type AnyClient } from "../client.js"
import { combineSignal } from "../deadline.js"
import { extract } from "../extract.js"
import type { CreateParams, Hooks, Message, WrapOptions } from "../types.js"
import { emptyUsage, sumUsage, type TokenUsage } from "../usage.js"
import { chunkDocument, type Chunker } from "./chunker.js"
import { DocumentChunkError, DocumentNoDataError } from "./errors.js"
import { mergeInto, type ChunkValue, type DedupeMode } from "./merge.js"

export { chunkDocument, defaultChunker } from "./chunker.js"
export type { Chunker, ChunkerOptions, DocumentChunk } from "./chunker.js"
export {
  DocumentChunkError,
  DocumentMergeError,
  DocumentNoDataError,
} from "./errors.js"
export { mergeChunks, mergeInto } from "./merge.js"
export type { ChunkValue, DedupeMode, MergeOptions } from "./merge.js"
// The chunk descriptor createDocument() puts on every hook's AttemptMeta.
export type { AttemptMeta, ChunkMeta } from "../types.js"

const DEFAULT_CHUNK_SIZE = 2000
const DEFAULT_OVERLAP = 100

/** One chunk's contribution, positioned in the original document. */
export type ChunkOutcome = {
  index: number
  /** Absolute offset into the document the caller passed in. */
  startIndex: number
  endIndex: number
  /** The value this chunk produced, or undefined when it failed. */
  value: unknown
  /** Present only when this chunk failed. */
  error?: DocumentChunkError
  usage: TokenUsage
}

export type DocumentResult<T> = {
  /** Merged from every successful chunk, then validated against `schema`. */
  data: T
  /** Per-chunk provenance, in document order. */
  chunks: ChunkOutcome[]
  /** Summed across every chunk, including failed ones. */
  usage: TokenUsage
}

export type DocumentParams<T extends z.ZodType> = Omit<
  CreateParams<T>,
  "messages" | "context" | "tokenBudget" | "timeout"
> & {
  /** The plain-text document to extract from. */
  document: string
  /** What to extract, sent to the model alongside each chunk. */
  instruction: string
  /**
   * Target characters per chunk. The chunker's default tokenizer is
   * character-based, so this is a character count, not a token count.
   * Default: 2000.
   */
  chunkSize?: number
  /**
   * Characters bled outward on each side of a chunk, so content cut at a
   * boundary still appears whole in one window. Default: 100. Set 0 to disable.
   */
  overlap?: number
  /**
   * Schema used to validate each chunk. Defaults to `schema`.
   *
   * A chunk usually holds only part of the document, so a schema with required
   * fields will fail on most chunks. Pass a chunk-tolerant version here (fields
   * `.nullable()`, arrays allowed to be empty) while keeping `schema` strict for
   * the merged result.
   */
  chunkSchema?: z.ZodType
  /** Replace the default chunker. Useful in tests, and for custom splitting. */
  chunker?: Chunker
  /**
   * What to do when a chunk exhausts its retries. Default: "skip".
   *
   * "skip" records the failure on `chunks[i].error` and keeps going; "abort"
   * throws immediately. An aborted `signal` always propagates either way.
   *
   * "skip" is not a licence to return nothing: when every chunk fails the call
   * throws `DocumentNoDataError` rather than a successful-looking empty object.
   */
  onChunkError?: "skip" | "abort"
  /**
   * How to treat a value more than one chunk reported in an array field.
   *
   * - `"overlap"` (default): count it once when the two chunks' windows
   *   overlap, since overlapping windows read the same text. A repeat inside
   *   one chunk is kept.
   * - `"none"`: keep every repeat. Use when the document may legitimately
   *   contain the same item twice (two identical invoice lines, say).
   */
  dedupe?: DedupeMode
  /**
   * Cumulative token budget for the **whole document**.
   *
   * Unlike `create()`, where `tokenBudget` covers one call, a document becomes
   * many chunks, so the budget spans all of them: it is measured across every
   * chunk and every reask, and `tokenBudget: 50_000` on a 100-chunk document
   * means 50k tokens total, not 50k per chunk. Once the running total reaches
   * it, no further chunk is started and the call throws `TokenBudgetExceeded`
   * (or `TokenUsageUnavailableError` when a response omitted usage metadata) —
   * like an aborted `signal`, already-extracted chunks are not returned. The
   * error's `usage` is the document-wide total.
   *
   * Set `chunkTokenBudget` as well to also cap each chunk individually.
   */
  tokenBudget?: number
  /**
   * Cumulative token budget for **each chunk**, on top of `tokenBudget`.
   *
   * The per-chunk guardrail `create()` has always offered: a chunk that reaches
   * this total stops reasking and fails, which `onChunkError` then treats like
   * any other chunk failure. Useful when one runaway chunk must not consume the
   * whole document's budget.
   */
  chunkTokenBudget?: number
  /**
   * Wall-clock budget for the **whole document**, in milliseconds.
   *
   * Unlike `create()`, where one call is one request, a document becomes many
   * chunks, so the deadline is shared: it is started once and every chunk runs
   * under it. `timeout: 30_000` on a 100-chunk document means 30 seconds total,
   * not 30 seconds per chunk. When it elapses the chunk in flight is aborted
   * and the call throws, like an aborted `signal` — already-extracted chunks
   * are not returned.
   */
  timeout?: number
}

/**
 * Rebuild the `create()` options for one chunk.
 *
 * `params.tokenBudget` is the document-wide budget and is deliberately **not**
 * forwarded: the chunk's own guardrail is `params.chunkTokenBudget`. The two
 * are different scopes of the same mechanism, so passing the document total to
 * a chunk would let one chunk spend the whole document's allowance.
 */
function chunkParams(
  params: DocumentParams<z.ZodType>,
  schema: z.ZodType,
  chunkText: string,
  hooks: Hooks,
  /**
   * The document-wide signal, already carrying the deadline. Passed as the
   * chunk's `signal` rather than as a `timeout`: each chunk would otherwise
   * start its own timer, making the budget per-chunk (N x timeout) instead of
   * the whole document's.
   */
  signal: AbortSignal | undefined,
): CreateParams<z.ZodType> {
  const next: CreateParams<z.ZodType> = {
    model: params.model,
    schema,
    messages: [
      {
        role: "user",
        content: `${params.instruction}\n\n---\n\n${chunkText}`,
      } satisfies Message,
    ],
    // Lets cited() verify quotes against this chunk's text.
    context: chunkText,
    hooks,
  }
  if (params.maxRetries !== undefined) next.maxRetries = params.maxRetries
  if (params.mode !== undefined) next.mode = params.mode
  if (signal !== undefined) next.signal = signal
  if (params.chunkTokenBudget !== undefined) {
    next.tokenBudget = params.chunkTokenBudget
  }
  if (params.temperature !== undefined) next.temperature = params.temperature
  if (params.max_tokens !== undefined) next.max_tokens = params.max_tokens
  if (params.top_p !== undefined) next.top_p = params.top_p
  return next
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

/**
 * Extract one structured value from a whole document.
 *
 * The document is split into positioned chunks; each chunk runs through the
 * same `create()` loop (reask, modes, hooks, token budget, abort signal), and
 * the per-chunk results are merged and validated against `schema`.
 *
 * Merging is deterministic and does not call the model: array fields are
 * concatenated, and a repeat two chunks reported is dropped only when their
 * windows overlap (`dedupe: "none"` keeps every repeat); other fields take the
 * first non-null value in chunk order. It cannot reconcile a value reworded
 * across two chunks, and a record longer than `overlap` that straddles a
 * boundary can still be lost.
 */
export async function createDocument<T extends z.ZodType>(
  client: AnyClient,
  params: DocumentParams<T>,
  options?: WrapOptions,
): Promise<DocumentResult<z.infer<T>>> {
  const { llm, defaults } = toLLMClient(client, options)
  const chunkSchema = params.chunkSchema ?? params.schema
  const onChunkError = params.onChunkError ?? "skip"
  // Validate before the loop. A bad maxRetries would otherwise fail every
  // chunk, and the catch below would wrap a configuration error into a
  // DocumentChunkError, burying the cause one layer deeper.
  assertMaxRetries(params.maxRetries ?? defaults?.maxRetries)
  // The document-wide budget. `create()` measures one call; here the same
  // number measures the whole document, which is why the per-chunk guardrail
  // moved to `chunkTokenBudget`. Validated up front for the same reason as
  // maxRetries: a bad value should fail once, not once per chunk.
  const tokenBudget = assertTokenBudget(params.tokenBudget ?? defaults?.tokenBudget)
  assertTokenBudget(params.chunkTokenBudget)
  // One deadline for the whole document, started here and shared by every
  // chunk. `create()` would start its own timer per chunk, which would make
  // the budget per-chunk.
  const signal = combineSignal(
    params.signal,
    assertTimeout(params.timeout ?? defaults?.timeout),
  )
  // Hand extract() a `defaults` with `timeout` and `tokenBudget` removed. Both
  // are enforced here at document scope — the deadline already rides on
  // `signal`, and the budget is checked between chunks — so leaving them in
  // would make extract() apply each of them *again*, per chunk. For `timeout`
  // that is merely a redundant timer (the shared deadline starts earlier and
  // always fires first); for `tokenBudget` it would be a real behaviour change,
  // silently reinstating the per-chunk cap this API just replaced.
  const chunkDefaults: WrapOptions | undefined =
    defaults === undefined || (defaults.timeout === undefined && defaults.tokenBudget === undefined)
      ? defaults
      : (() => {
          const { timeout: _t, tokenBudget: _b, ...rest } = defaults
          return rest
        })()

  const chunks = await chunkDocument(params.document, {
    chunkSize: params.chunkSize ?? DEFAULT_CHUNK_SIZE,
    overlap: params.overlap ?? DEFAULT_OVERLAP,
    ...(params.chunker !== undefined ? { chunker: params.chunker } : {}),
  })

  const outcomes: ChunkOutcome[] = []
  const values: ChunkValue[] = []
  const chunkErrors: DocumentChunkError[] = []
  let usage = emptyUsage()
  // Stays true only while every chunk's every attempt reported usage. A
  // document-wide budget can only be measured against a complete total, so one
  // silent chunk makes it unenforceable — the same fail-closed rule create()
  // applies within a call, lifted to the document.
  let usageAvailable = true

  for (const [index, chunk] of chunks.entries()) {
    signal?.throwIfAborted()

    // The document budget, checked before each chunk rather than after, so it
    // blocks the *next* chunk instead of discarding one already paid for. This
    // is create()'s rule at document scale: the guardrail stops the loop, it
    // does not invalidate work already done. A document whose final chunk
    // crosses the budget is therefore still returned.
    if (index > 0 && tokenBudget !== undefined) {
      const overBudget = budgetError(
        tokenBudget,
        usageAvailable,
        usage,
        usage.attempts,
        "Document token budget",
      )
      if (overBudget !== undefined) {
        throw overBudget
      }
    }

    // extract() merges wrap-level hooks with per-call hooks; do the same here
    // so the capture sees the same handlers the caller will.
    const userHooks: Hooks = { ...defaults?.hooks, ...params.hooks }
    let chunkUsage = emptyUsage()
    // Whether this chunk's attempts all reported usage. extract() reports it
    // through the observe callback below, on success and failure alike.
    let chunkUsageAvailable = true
    const hooks: Hooks = {
      ...userHooks,
      onUsage: (snapshot, meta) => {
        // The last emission of a call is that call's cumulative total.
        chunkUsage = snapshot
        userHooks.onUsage?.(snapshot, meta)
      },
    }

    let value: unknown
    try {
      value = await extract(
        llm,
        chunkParams(params, chunkSchema, chunk.text, hooks, signal),
        chunkDefaults,
        // Lets every hook attribute its event to this chunk, which a plain
        // create() call has no need for.
        {
          index,
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
          total: chunks.length,
        },
        { onUsageAvailable: (available) => (chunkUsageAvailable = available) },
      )
    } catch (error) {
      usageAvailable = usageAvailable && chunkUsageAvailable
      // An aborted signal or an elapsed deadline stops the whole document:
      // the caller asked for the run to end, so a failed chunk is not a
      // per-chunk problem to record and move past.
      if (isAbort(error) || signal?.aborted) {
        throw error
      }
      const failure = new DocumentChunkError(
        `Chunk ${index} failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          index,
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
          cause: error,
          usage: chunkUsage,
        },
      )
      usage = sumUsage(usage, chunkUsage)
      chunkErrors.push(failure)
      if (onChunkError === "abort") {
        throw failure
      }
      outcomes.push({
        index,
        startIndex: chunk.startIndex,
        endIndex: chunk.endIndex,
        value: undefined,
        error: failure,
        usage: chunkUsage,
      })
      continue
    }

    usageAvailable = usageAvailable && chunkUsageAvailable
    usage = sumUsage(usage, chunkUsage)
    values.push({
      value,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
    })
    outcomes.push({
      index,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      value,
      usage: chunkUsage,
    })
  }

  // Nothing to merge. Checked before mergeInto, so the failure names itself
  // instead of surfacing as a schema error — the schema is fine; the chunks
  // are the problem. A blank document reaches here with no chunks at all.
  if (values.length === 0) {
    const reason = chunks.length === 0 ? "empty-document" : "all-chunks-failed"
    throw new DocumentNoDataError(
      reason === "empty-document"
        ? "The document was empty, so no chunks were extracted"
        : `All ${chunks.length} chunk(s) failed, so there is nothing to merge`,
      { reason, chunkErrors, usage },
    )
  }

  return {
    data: mergeInto(params.schema, values, chunkErrors, {
      dedupe: params.dedupe ?? "overlap",
    }),
    chunks: outcomes,
    usage,
  }
}
