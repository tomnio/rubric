import type { z } from "zod"
import { rootKind } from "../schema.js"
import {
  DocumentConflictError,
  DocumentMergeError,
  type ConflictEntry,
  type DocumentChunkError,
} from "./errors.js"

/** One chunk's contribution to the merge, with the window it was read from. */
export type ChunkValue = {
  value: unknown
  /** Absolute offset of the chunk's window in the document. */
  startIndex: number
  endIndex: number
}

/**
 * How array fields treat a value that more than one chunk reported.
 *
 * - `"overlap"` (default): a value seen in two *different* chunks counts once
 *   when those chunks' windows overlap, because overlapping windows are two
 *   views of the same text. A repeat inside a single chunk is kept — windowing
 *   cannot have caused it.
 * - `"none"`: concatenate and keep every repeat. Use when the document may
 *   legitimately contain the same item twice.
 */
export type DedupeMode = "overlap" | "none"

/**
 * How to treat two chunks that reported different values for the same
 * non-array field.
 *
 * - `"first"` (default): keep the first non-null value in chunk order and drop
 *   the rest silently. Chunk order roughly follows document order, so this is
 *   usually the value the caller wants.
 * - `"error"`: throw `DocumentConflictError` instead, listing every field the
 *   chunks disagreed on and every value each one reported. Use this when a
 *   silent choice would hide a real disagreement in the document.
 *
 * Two chunks that agree are never a conflict: equality is the same structural
 * comparison array dedupe uses, so overlapping windows that read the same text
 * (the common case) pass. Array fields are exempt — they concatenate, so there
 * is nothing to choose between.
 */
export type ConflictMode = "first" | "error"

export type MergeOptions = {
  /** Default: `"overlap"`. */
  dedupe?: DedupeMode
  /** Default: `"first"`. */
  onConflict?: ConflictMode
}

/**
 * True for an object literal or `Object.create(null)` — a bag of own keys.
 *
 * Deliberately strict. A `Date`, `Map`, `Set`, `RegExp`, or class instance is an
 * object but not a bag of keys, and treating one as a bag is how structurally
 * different values used to compare equal during dedupe.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

/**
 * Hands out a stable index per opaque value, so the same value compares equal
 * to itself and to nothing else.
 *
 * A plain `Map`, not a `WeakMap`: symbols are valid identity keys but not valid
 * `WeakMap` keys. The table lives only for the duration of one `dedupe()` call,
 * so it cannot retain anything past it.
 */
type IdentityTable = {
  ids: Map<unknown, number>
  next: number
}

function identity(value: unknown, table: IdentityTable): number {
  const known = table.ids.get(value)
  if (known !== undefined) {
    return known
  }
  const id = table.next
  table.ids.set(value, id)
  table.next += 1
  return id
}

/**
 * A key that is equal exactly when two values are structurally equal.
 *
 * `JSON.stringify` alone is not sound here. It is key-order sensitive, it
 * renders `NaN` and `Infinity` as `null` so they collide with `null`, and it
 * renders `Date` / `Map` / `Set` / `RegExp` and class instances as `{}` or their
 * enumerable own keys, so structurally different values collide. This walks the
 * value instead, tagging every node with its type, so two nodes share a key only
 * if they agree on both type and content. String payloads are length-prefixed,
 * so no content can imitate a separator and the encoding stays injective.
 *
 * A value with no structural form — a class instance, a function — is opaque:
 * equal only to itself, tracked by identity. That is the safe direction, since
 * an unrecognised duplicate survives rather than a distinct value disappearing.
 */
function dedupeKey(value: unknown, identities: IdentityTable): string {
  if (value === null) {
    return "null"
  }
  switch (typeof value) {
    case "undefined":
      return "undefined"
    case "boolean":
      return value ? "true" : "false"
    case "number":
      // `String` already separates NaN and Infinity from every finite number.
      // -0 needs its own branch: `Object.is(-0, 0)` is false, `String(-0)` is "0".
      return `number:${Object.is(value, -0) ? "-0" : String(value)}`
    case "string":
      return `string:${value.length}:${value}`
    case "bigint":
      return `bigint:${value}`
    case "symbol":
      // `Symbol("x")` and `Symbol("x")` are different symbols that stringify
      // alike, while `Symbol.for("x")` is the same symbol twice. Identity gets
      // both right; the description does not.
      return `symbol:${identity(value, identities)}`
    case "function":
      return `opaque:${identity(value, identities)}`
    default:
      return objectKey(value, identities)
  }
}

function objectKey(value: object, identities: IdentityTable): string {
  if (value instanceof Date) {
    // An invalid Date has no ISO string, so it gets a name of its own.
    return Number.isNaN(value.getTime())
      ? "date:invalid"
      : `date:${value.toISOString()}`
  }
  if (value instanceof RegExp) {
    return `regexp:${value.source.length}:${value.source}/${value.flags}`
  }
  if (value instanceof Map) {
    // A Map's value is its key→value pairs, not the order they were inserted,
    // so entries are sorted before they are encoded.
    const entries = [...value.entries()]
      .map(
        ([key, item]): [string, string] => [
          dedupeKey(key, identities),
          dedupeKey(item, identities),
        ],
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `map:${JSON.stringify(entries)}`
  }
  if (value instanceof Set) {
    // Likewise a Set's value is its members; insertion order is not part of it.
    const items = [...value].map((item) => dedupeKey(item, identities)).sort()
    return `set:${JSON.stringify(items)}`
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => dedupeKey(item, identities))
    return `array:${JSON.stringify(items)}`
  }
  if (isPlainRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [dedupeKey(key, identities), dedupeKey(value[key], identities)])
    return `object:${JSON.stringify(entries)}`
  }
  return `opaque:${identity(value, identities)}`
}

/** An array item, remembering which chunk reported it and where that chunk sat. */
type TaggedItem = {
  item: unknown
  chunk: number
  startIndex: number
  endIndex: number
  key: string
}

/** Two windows share text when their half-open ranges intersect. */
function windowsOverlap(a: TaggedItem, b: TaggedItem): boolean {
  return a.startIndex < b.endIndex && b.startIndex < a.endIndex
}

/**
 * Concatenate the arrays chunks reported for one field, dropping the repeats
 * that overlapping windows cause.
 *
 * The merge sees values, not positions, so it cannot tell "the overlap window
 * re-reported this item" from "the document really holds this item twice". Two
 * facts separate the cases well enough to act on:
 *
 * - A repeat **inside one chunk** is not an artifact of windowing — one window
 *   is one reading of one stretch of text — so it is kept.
 * - A repeat **across two chunks** is an artifact only if those chunks' windows
 *   overlap, because only then did two windows read the same text.
 *
 * What is left is the inherent limit: two genuine duplicates that happen to sit
 * in two overlapping chunks are still collapsed. With `dedupe: "none"` the
 * caller can opt out entirely.
 */
function mergeArrayField(
  chunks: ChunkValue[],
  mode: DedupeMode,
  identities: IdentityTable,
): unknown[] {
  const tagged: TaggedItem[] = []
  chunks.forEach((chunk, index) => {
    if (!Array.isArray(chunk.value)) {
      return
    }
    for (const item of chunk.value) {
      tagged.push({
        item,
        chunk: index,
        startIndex: chunk.startIndex,
        endIndex: chunk.endIndex,
        key: dedupeKey(item, identities),
      })
    }
  })

  if (mode === "none") {
    return tagged.map((entry) => entry.item)
  }

  // Per key, the occurrences still able to absorb a later repeat. A dropped
  // occurrence stays here too: its window did hold the item, so a later window
  // overlapping it may still be re-reporting that same sighting.
  const open = new Map<string, TaggedItem[]>()
  const kept: TaggedItem[] = []
  for (const candidate of tagged) {
    const pool = open.get(candidate.key) ?? []
    const absorbed = pool.findIndex(
      (previous) =>
        previous.chunk !== candidate.chunk && windowsOverlap(previous, candidate),
    )
    if (absorbed === -1) {
      kept.push(candidate)
    } else {
      pool.splice(absorbed, 1)
    }
    pool.push(candidate)
    open.set(candidate.key, pool)
  }
  return kept.map((entry) => entry.item)
}

/** One field's non-null values, with the windows they were read from. */
type FieldValues = {
  key: string
  values: Array<{ value: unknown; startIndex: number; endIndex: number }>
}

/**
 * True when every value in the list is structurally equal to the first.
 *
 * Uses the same key array dedupe does, so "equal" means the same thing in both
 * places: `{a:1,b:2}` equals `{b:2,a:1}`, two `Date`s holding one instant are
 * equal, and a class instance equals only itself.
 */
function allEqual(
  values: FieldValues["values"],
  identities: IdentityTable,
): boolean {
  if (values.length < 2) {
    return true
  }
  const first = values[0]
  if (first === undefined) {
    return true
  }
  const reference = dedupeKey(first.value, identities)
  return values.every(
    (entry) => dedupeKey(entry.value, identities) === reference,
  )
}

/**
 * Merge the object fields chunks reported, collecting any disagreement.
 *
 * A **conflict** is a non-array field two chunks reported with values that are
 * not structurally equal. `null` / `undefined` are treated as *absence*, not as
 * a value to compare: a chunk that did not see a field usually reports it as
 * null under a chunk-tolerant schema, and calling that a disagreement would
 * make `onConflict: "error"` unusable with the tolerant schema the document
 * API recommends. So the comparison is among the non-null values only.
 *
 * Conflicts are computed only when `onConflict` is `"error"` — the default
 * path does no extra work.
 */
function mergeObjectFields(
  chunks: ChunkValue[],
  mode: DedupeMode,
  identities: IdentityTable,
  onConflict: ConflictMode,
): { merged: Record<string, unknown>; conflicts: ConflictEntry[] } {
  const objects = chunks.map((chunk) => chunk.value).filter(isPlainRecord)
  const keys = new Set<string>()
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      keys.add(key)
    }
  }

  const merged: Record<string, unknown> = {}
  const conflicts: ConflictEntry[] = []
  for (const key of keys) {
    // Keep the chunk's window alongside its value: overlap-aware dedupe needs
    // to know where each value was read from.
    const seen = chunks.filter(
      (chunk): chunk is ChunkValue & { value: Record<string, unknown> } =>
        isPlainRecord(chunk.value) && key in chunk.value,
    )
    if (seen.length === 0) {
      continue
    }

    const present = seen.filter(
      (chunk) => chunk.value[key] !== null && chunk.value[key] !== undefined,
    )
    if (present.length === 0) {
      // Every chunk reported null/undefined. Preserve an explicit null so a
      // `.nullable()` field validates instead of looking absent.
      if (seen.some((chunk) => chunk.value[key] === null)) {
        merged[key] = null
      }
      continue
    }

    if (present.every((chunk) => Array.isArray(chunk.value[key]))) {
      merged[key] = mergeArrayField(
        present.map((chunk) => ({
          value: chunk.value[key],
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
        })),
        mode,
        identities,
      )
      continue
    }

    const values = present.map((chunk) => ({
      value: chunk.value[key],
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
    }))
    if (onConflict === "error" && !allEqual(values, identities)) {
      conflicts.push({ key, values })
    }
    merged[key] = present[0]?.value[key]
  }

  return { merged, conflicts }
}

/**
 * Combine per-chunk results into one object.
 *
 * Rules, decided per field by the runtime value:
 *
 * - **Array fields** are concatenated across chunks, and a value that two
 *   chunks reported is dropped only when their windows overlap — see
 *   `mergeArrayField`. `options.dedupe: "none"` keeps every repeat.
 * - **Every other field** takes the first non-null value seen, in chunk order.
 *   This includes nested objects, which are treated as atomic values.
 * - With `options.onConflict: "error"`, a non-array field two chunks reported
 *   with different values throws `DocumentConflictError` instead of keeping the
 *   first. See `ConflictMode`.
 *
 * A field that no chunk reported is omitted, so a required field is caught by
 * the final schema validation rather than invented here.
 *
 * This merges *object fields*. When the schema root is an array or a scalar the
 * merge is a different shape entirely — see `mergeInto`, which picks between
 * them from the schema.
 *
 * Pure and synchronous: no LLM call, no schema needed. Callers validate the
 * result separately (see `mergeInto`).
 */
export function mergeChunks(
  chunks: ChunkValue[],
  options: MergeOptions = {},
): Record<string, unknown> {
  const mode = options.dedupe ?? "overlap"
  const identities: IdentityTable = { ids: new Map<unknown, number>(), next: 0 }
  const { merged, conflicts } = mergeObjectFields(
    chunks,
    mode,
    identities,
    options.onConflict ?? "first",
  )
  if (conflicts.length > 0) {
    throw conflictError(conflicts, [])
  }
  return merged
}

/** Build the failure for a set of conflicts, phrased for the caller to act on. */
function conflictError(
  conflicts: ConflictEntry[],
  chunkErrors: DocumentChunkError[],
): DocumentConflictError {
  const fields = conflicts.map((conflict) => conflict.key).join(", ")
  return new DocumentConflictError(
    `Chunks disagreed on ${conflicts.length} field(s) under onConflict: "error": ${fields}. The document may state different values in different places; resolve the conflict, or use onConflict: "first" to keep the first value.`,
    { conflicts, chunkErrors },
  )
}

/**
 * Merge per-chunk values when the schema root is an array.
 *
 * Chunks each report part of the list, so the parts concatenate — the same
 * rule array *fields* follow, including overlap-aware dedupe.
 */
function mergeRootArray(
  chunks: ChunkValue[],
  mode: DedupeMode,
  identities: IdentityTable,
): unknown {
  return mergeArrayField(chunks, mode, identities)
}

/**
 * Merge per-chunk values when the schema root is neither an object nor an
 * array — a `z.date()`, `z.string()`, and so on.
 *
 * There is only one value to end up with, so the first non-null one wins, as
 * with a scalar field. An explicit null survives when no chunk reported a
 * value, so a `.nullable()` root validates instead of looking absent.
 */
function mergeRootScalar(values: unknown[]): unknown {
  const present = values.filter((value) => value !== null && value !== undefined)
  if (present.length > 0) {
    return present[0]
  }
  return values.some((value) => value === null) ? null : undefined
}

/**
 * Merge chunk results and validate the combination against the full schema.
 *
 * The merge strategy follows the schema's root shape, because runtime values
 * alone cannot distinguish an array root from an object one — or a `z.date()`
 * root from an object one, since a Date is an object to `typeof`.
 *
 * The merged result can fail even when every chunk passed on its own: a
 * required field may appear in no chunk, or two chunks may contribute values
 * that cannot both hold.
 */
export function mergeInto<T extends z.ZodType>(
  schema: T,
  chunks: ChunkValue[],
  chunkErrors: DocumentChunkError[] = [],
  options: MergeOptions = {},
): z.infer<T> {
  const mode = options.dedupe ?? "overlap"
  const onConflict = options.onConflict ?? "first"
  const identities: IdentityTable = { ids: new Map<unknown, number>(), next: 0 }
  const kind = rootKind(schema)

  let partial: unknown
  let conflicts: ConflictEntry[] = []
  if (kind === "object") {
    const result = mergeObjectFields(chunks, mode, identities, onConflict)
    partial = result.merged
    conflicts = result.conflicts
  } else if (kind === "array") {
    // Arrays concatenate, so there is no field to disagree on.
    partial = mergeRootArray(chunks, mode, identities)
  } else {
    // A scalar root has exactly one value to end up with, so a second,
    // different value is the same conflict as a scalar field's.
    const values = chunks
      .filter((chunk) => chunk.value !== null && chunk.value !== undefined)
      .map((chunk) => ({
        value: chunk.value,
        startIndex: chunk.startIndex,
        endIndex: chunk.endIndex,
      }))
    if (onConflict === "error" && !allEqual(values, identities)) {
      conflicts = [{ key: "(root)", values }]
    }
    partial = mergeRootScalar(chunks.map((chunk) => chunk.value))
  }

  if (conflicts.length > 0) {
    throw conflictError(conflicts, chunkErrors)
  }

  const parsed = schema.safeParse(partial)
  if (!parsed.success) {
    throw new DocumentMergeError(
      "Merged document output failed schema validation",
      { issues: parsed.error.issues, partial, chunkErrors },
    )
  }
  return parsed.data
}
