import type { z } from "zod"
import { DocumentMergeError, type DocumentChunkError } from "./errors.js"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Recursively sort object keys so structurally equal values serialize alike. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key])
    }
    return sorted
  }
  return value
}

function deepKey(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** Drop later duplicates, keeping first-occurrence order. */
function dedupe(items: unknown[]): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const item of items) {
    const key = deepKey(item)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Combine per-chunk results into one object.
 *
 * Rules, decided by the runtime value rather than by introspecting the schema:
 *
 * - **Array fields** are concatenated across chunks and deduplicated by deep
 *   structural equality.
 * - **Every other field** takes the first non-null value seen, in chunk order.
 *   This includes nested objects, which are treated as atomic values.
 *
 * A field that no chunk reported is omitted, so a required field is caught by
 * the final schema validation rather than invented here.
 *
 * Pure and synchronous: no LLM call, no schema needed. Callers validate the
 * result separately (see `mergeInto`).
 */
export function mergeChunks(values: unknown[]): Record<string, unknown> {
  const objects = values.filter(isPlainObject)
  const keys = new Set<string>()
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      keys.add(key)
    }
  }

  const merged: Record<string, unknown> = {}
  for (const key of keys) {
    const seen = objects
      .filter((object) => key in object)
      .map((object) => object[key])
    if (seen.length === 0) {
      continue
    }

    const present = seen.filter((value) => value !== null && value !== undefined)
    if (present.length === 0) {
      // Every chunk reported null/undefined. Preserve an explicit null so a
      // `.nullable()` field validates instead of looking absent.
      if (seen.some((value) => value === null)) {
        merged[key] = null
      }
      continue
    }

    if (present.every(Array.isArray)) {
      merged[key] = dedupe((present as unknown[][]).flat())
      continue
    }

    merged[key] = present[0]
  }

  return merged
}

/**
 * Merge chunk results and validate the combination against the full schema.
 *
 * The merged object can fail even when every chunk passed on its own: a
 * required field may appear in no chunk, or two chunks may contribute values
 * that cannot both hold.
 */
export function mergeInto<T extends z.ZodType>(
  schema: T,
  values: unknown[],
  chunkErrors: DocumentChunkError[] = [],
): z.infer<T> {
  const partial = mergeChunks(values)
  const parsed = schema.safeParse(partial)
  if (!parsed.success) {
    throw new DocumentMergeError(
      "Merged document output failed schema validation",
      { issues: parsed.error.issues, partial, chunkErrors },
    )
  }
  return parsed.data
}
