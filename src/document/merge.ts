import type { z } from "zod"
import { rootKind } from "../schema.js"
import { DocumentMergeError, type DocumentChunkError } from "./errors.js"

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

/** Drop later duplicates, keeping first-occurrence order. */
function dedupe(items: unknown[]): unknown[] {
  const seen = new Set<string>()
  // One identity table per call, so the same opaque instance is recognised
  // across every item while two distinct instances stay distinct.
  const identities: IdentityTable = { ids: new Map<unknown, number>(), next: 0 }
  const out: unknown[] = []
  for (const item of items) {
    const key = dedupeKey(item, identities)
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
 * Rules, decided per field by the runtime value:
 *
 * - **Array fields** are concatenated across chunks and deduplicated by deep
 *   structural equality.
 * - **Every other field** takes the first non-null value seen, in chunk order.
 *   This includes nested objects, which are treated as atomic values.
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
export function mergeChunks(values: unknown[]): Record<string, unknown> {
  const objects = values.filter(isPlainRecord)
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
 * Merge per-chunk values when the schema root is an array.
 *
 * Chunks each report part of the list, so the parts concatenate — the same
 * rule array *fields* follow. Dedupe removes what overlapping windows report
 * twice.
 */
function mergeRootArray(values: unknown[]): unknown {
  const arrays = values.filter(Array.isArray) as unknown[][]
  return dedupe(arrays.flat())
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
  values: unknown[],
  chunkErrors: DocumentChunkError[] = [],
): z.infer<T> {
  const kind = rootKind(schema)
  const partial =
    kind === "object"
      ? mergeChunks(values)
      : kind === "array"
        ? mergeRootArray(values)
        : mergeRootScalar(values)

  const parsed = schema.safeParse(partial)
  if (!parsed.success) {
    throw new DocumentMergeError(
      "Merged document output failed schema validation",
      { issues: parsed.error.issues, partial, chunkErrors },
    )
  }
  return parsed.data
}
