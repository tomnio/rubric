import type { z } from "zod"
import { assertMaxRetries } from "../budget.js"
import { toLLMClient, type AnyClient } from "../client.js"
import { extract } from "../extract.js"
import type { CreateParams, Hooks, Message, WrapOptions } from "../types.js"
import { emptyUsage, sumUsage, type TokenUsage } from "../usage.js"
import { chunkDocument, type Chunker } from "./chunker.js"
import { DocumentChunkError } from "./errors.js"
import { mergeInto, type ChunkValue, type DedupeMode } from "./merge.js"

export { chunkDocument, defaultChunker } from "./chunker.js"
export type { Chunker, ChunkerOptions, DocumentChunk } from "./chunker.js"
export { DocumentChunkError, DocumentMergeError } from "./errors.js"
export { mergeChunks, mergeInto } from "./merge.js"
export type { ChunkValue, DedupeMode, MergeOptions } from "./merge.js"

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
  "messages" | "context"
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
}

/** Rebuild the `create()` options for one chunk. */
function chunkParams(
  params: { instruction: string } & Omit<
    CreateParams<z.ZodType>,
    "messages" | "context"
  >,
  schema: z.ZodType,
  chunkText: string,
  hooks: Hooks,
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
  if (params.signal !== undefined) next.signal = params.signal
  if (params.tokenBudget !== undefined) next.tokenBudget = params.tokenBudget
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

  const chunks = await chunkDocument(params.document, {
    chunkSize: params.chunkSize ?? DEFAULT_CHUNK_SIZE,
    overlap: params.overlap ?? DEFAULT_OVERLAP,
    ...(params.chunker !== undefined ? { chunker: params.chunker } : {}),
  })

  const outcomes: ChunkOutcome[] = []
  const values: ChunkValue[] = []
  const chunkErrors: DocumentChunkError[] = []
  let usage = emptyUsage()

  for (const [index, chunk] of chunks.entries()) {
    params.signal?.throwIfAborted()

    // extract() merges wrap-level hooks with per-call hooks; do the same here
    // so the capture sees the same handlers the caller will.
    const userHooks: Hooks = { ...defaults?.hooks, ...params.hooks }
    let chunkUsage = emptyUsage()
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
        chunkParams(params, chunkSchema, chunk.text, hooks),
        defaults,
      )
    } catch (error) {
      if (isAbort(error) || params.signal?.aborted) {
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

  return {
    data: mergeInto(params.schema, values, chunkErrors, {
      dedupe: params.dedupe ?? "overlap",
    }),
    chunks: outcomes,
    usage,
  }
}
