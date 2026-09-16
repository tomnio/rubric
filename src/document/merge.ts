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

/**
 * A field name, or several to combine into one key, that identifies the same
 * array item across chunks.
 *
 * Array items are normally deduped by their whole value, so an entity the model
 * reworded in two overlapping windows — `{ sku: "A1", desc: "Coffee" }` in one,
 * `{ sku: "A1", price: 5 }` in the next — is deep-unequal and survives twice,
 * with each copy holding half the fields. Naming the field that identifies the
 * entity (`dedupeBy: "sku"`) lets the merge recognise the two readings as one
 * item and **union their fields** rather than keep two half-filled copies.
 *
 * The key is the value of the named field(s) in an item. Several names make a
 * composite key, and every one must be present and non-null for the item to be
 * identifiable; an item missing any of them falls back to full-value equality,
 * which is the safe direction — it stays a separate item rather than being
 * merged into one it may not match.
 */
export type DedupeBy = string | readonly string[]

export type MergeOptions = {
  /** Default: `"overlap"`. */
  dedupe?: DedupeMode
  /** Default: `"first"`. */
  onConflict?: ConflictMode
  /** Field(s) that identify the same array item across chunks. See `DedupeBy`. */
  dedupeBy?: DedupeBy
}

/**
 * The state one merge threads through every level.
 *
 * Kept in one object rather than as loose parameters because the nested calls
 * (object fields, array fields, root shapes) all need the same identity table —
 * which is what makes equality consistent between dedupe and conflict checks —
 * and the same list to collect conflicts into.
 */
type MergeContext = {
  mode: DedupeMode
  onConflict: ConflictMode
  identities: IdentityTable
  /** Normalised `dedupeBy`: the field names, or undefined when unset. */
  dedupeBy: readonly string[] | undefined
  /** Filled in by the merge; thrown by the caller that knows the scope. */
  conflicts: ConflictEntry[]
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
 * `WeakMap` keys. The table lives only for the duration of one merge, so it
 * cannot retain anything past it.
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
function windowsOverlap(
  a: { startIndex: number; endIndex: number },
  b: { startIndex: number; endIndex: number },
): boolean {
  return a.startIndex < b.endIndex && b.startIndex < a.endIndex
}

/** Normalise `dedupeBy` to the field-name list, or undefined when it is off. */
function normalizeDedupeBy(dedupeBy: DedupeBy | undefined): readonly string[] | undefined {
  if (dedupeBy === undefined) {
    return undefined
  }
  const fields = typeof dedupeBy === "string" ? [dedupeBy] : dedupeBy
  // An empty key list would match every plain object, collapsing the whole
  // array into one item. Treat it as "off" rather than let it do that.
  return fields.length === 0 ? undefined : fields
}

/**
 * The key an array item is deduped by.
 *
 * With `dedupeBy` set, an item that is an object carrying every named field
 * (non-null) is keyed by those fields' values, so two readings of one entity
 * match even when the rest of their fields differ. Everything else — a scalar
 * item, a missing or null key field — falls back to the item's full structural
 * key, so it dedupes exactly as it would without `dedupeBy`.
 *
 * The `entity:` prefix keeps this namespace apart from the structural keys
 * (`array:`, `object:`, `number:`, ...), so the two can never collide.
 */
function itemKey(item: unknown, ctx: MergeContext): string {
  const fields = ctx.dedupeBy
  if (fields !== undefined && isPlainRecord(item)) {
    const parts: string[] = []
    for (const field of fields) {
      const value = item[field]
      if (value === null || value === undefined) {
        return dedupeKey(item, ctx.identities)
      }
      parts.push(dedupeKey(value, ctx.identities))
    }
    return `entity:${JSON.stringify(parts)}`
  }
  return dedupeKey(item, ctx.identities)
}

/**
 * Fold a later reading of one entity into the kept one.
 *
 * Two overlapping windows can each see part of an entity — one the header, the
 * next the amount — so dropping the second reading would lose those fields.
 * Instead each field the kept item is missing is filled from the later one,
 * and a field both saw keeps the **first** non-null value, the same rule a
 * scalar field follows. A non-object item has no fields to union, so the kept
 * one stands as-is (they were structurally equal anyway, or they would not
 * share a key).
 */
function mergeEntity(target: unknown, source: unknown): unknown {
  if (!isPlainRecord(target) || !isPlainRecord(source)) {
    return target
  }
  const merged: Record<string, unknown> = { ...target }
  for (const key of Object.keys(source)) {
    const incoming = source[key]
    if (incoming === null || incoming === undefined) {
      continue
    }
    const current = merged[key]
    if (current === null || current === undefined) {
      merged[key] = incoming
    }
  }
  return merged
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
 *
 * When a repeat is dropped, its fields are not discarded — they are folded into
 * the kept item (see `mergeEntity`), so a field only the dropped window saw
 * survives.
 */
function mergeArrayField(chunks: ChunkValue[], ctx: MergeContext): unknown[] {
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
        key: itemKey(item, ctx),
      })
    }
  })

  if (ctx.mode === "none") {
    return tagged.map((entry) => entry.item)
  }

  // Per key, the occurrences still able to absorb a later repeat. A dropped
  // occurrence stays here too: its window did hold the item, so a later window
  // overlapping it may still be re-reporting that same sighting.
  const open = new Map<string, TaggedItem[]>()
  // Per key, the item that was actually kept. A dropped repeat folds into this
  // one, not into whichever occurrence happened to absorb it.
  const keptByKey = new Map<string, TaggedItem>()
  const kept: TaggedItem[] = []
  for (const candidate of tagged) {
    const pool = open.get(candidate.key) ?? []
    const absorbed = pool.findIndex(
      (previous) =>
        previous.chunk !== candidate.chunk && windowsOverlap(previous, candidate),
    )
    if (absorbed === -1) {
      kept.push(candidate)
      if (!keptByKey.has(candidate.key)) {
        keptByKey.set(candidate.key, candidate)
      }
    } else {
      pool.splice(absorbed, 1)
      const representative = keptByKey.get(candidate.key)
      if (representative !== undefined) {
        representative.item = mergeEntity(representative.item, candidate.item)
      }
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
  ctx: MergeContext,
): Record<string, unknown> {
  const objects = chunks.map((chunk) => chunk.value).filter(isPlainRecord)
  const keys = new Set<string>()
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      keys.add(key)
    }
  }

  const merged: Record<string, unknown> = {}
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
        ctx,
      )
      continue
    }

    const values = present.map((chunk) => ({
      value: chunk.value[key],
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
    }))
    if (ctx.onConflict === "error" && !allEqual(values, ctx.identities)) {
      ctx.conflicts.push({ key, values })
    }
    merged[key] = present[0]?.value[key]
  }

  return merged
}

/**
 * Combine per-chunk results into one object.
 *
 * Rules, decided per field by the runtime value:
 *
 * - **Array fields** are concatenated across chunks, and a value that two
 *   chunks reported is dropped only when their windows overlap — see
 *   `mergeArrayField`. `options.dedupe: "none"` keeps every repeat, and
 *   `options.dedupeBy` names the field that identifies an item across chunks.
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
  const ctx = createContext(options)
  const merged = mergeObjectFields(chunks, ctx)
  if (ctx.conflicts.length > 0) {
    throw conflictError(ctx.conflicts, [])
  }
  return merged
}

function createContext(options: MergeOptions): MergeContext {
  return {
    mode: options.dedupe ?? "overlap",
    onConflict: options.onConflict ?? "first",
    identities: { ids: new Map<unknown, number>(), next: 0 },
    dedupeBy: normalizeDedupeBy(options.dedupeBy),
    conflicts: [],
  }
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
  const ctx = createContext(options)
  const kind = rootKind(schema)

  let partial: unknown
  if (kind === "object") {
    partial = mergeObjectFields(chunks, ctx)
  } else if (kind === "array") {
    // Arrays concatenate, so there is no field to disagree on.
    partial = mergeArrayField(chunks, ctx)
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
    if (ctx.onConflict === "error" && !allEqual(values, ctx.identities)) {
      ctx.conflicts.push({ key: "(root)", values })
    }
    partial = mergeRootScalar(chunks.map((chunk) => chunk.value))
  }

  if (ctx.conflicts.length > 0) {
    throw conflictError(ctx.conflicts, chunkErrors)
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
