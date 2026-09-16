import type { z } from "zod"
import { isPlainObject, type CompletenessLookup } from "./completeness.js"

type ZodDef = {
  /** v3: "ZodObject"-style class name; v4: "object"-style kind string. */
  typeName?: string
  /** v4 kind string ("object", "array", …); v3 inner schema slot. */
  type?: string | z.ZodType
  /** v4 array element. */
  element?: z.ZodType
  innerType?: z.ZodType
  schema?: z.ZodType
}

const KIND_BY_TYPE_NAME: Record<string, string> = {
  ZodObject: "object",
  ZodArray: "array",
  ZodOptional: "optional",
  ZodNullable: "nullable",
  ZodDefault: "default",
  ZodEffects: "effects",
  ZodBranded: "branded",
}

function def(schema: z.ZodType): ZodDef & { kind: string } {
  const raw = schema._def as ZodDef
  // Same normalization as schema.ts: v4 carries the kind on _def.type (a
  // string), v3 on _def.typeName (a class name). typeof tells them apart.
  const v4Kind = typeof raw.type === "string" ? raw.type : undefined
  const kind =
    v4Kind ??
    (raw.typeName ? (KIND_BY_TYPE_NAME[raw.typeName] ?? raw.typeName) : "unknown")
  return { ...raw, kind }
}

/** Strip optional / nullable / default / effects wrappers to reach the shape. */
function unwrap(schema: z.ZodType): z.ZodType {
  let inner = schema
  for (;;) {
    const kind = def(inner).kind
    if (
      kind === "optional" ||
      kind === "nullable" ||
      kind === "default"
    ) {
      inner = def(inner).innerType as z.ZodType
      continue
    }
    if (kind === "effects") {
      // v3 wraps refinements in ZodEffects; v4 keeps the base kind in place.
      inner = def(inner).schema as z.ZodType
      continue
    }
    if (kind === "branded") {
      inner = def(inner).innerType as z.ZodType
      continue
    }
    break
  }
  return inner
}

export type SnapshotResult = { ok: boolean; value: unknown }

/**
 * Build a streaming snapshot that only trusts subtrees the tracker says are
 * closed.
 *
 * - Closed path → validate against the real schema. A failure is a definitive
 *   error, so the subtree is dropped rather than shown as data.
 * - Open path → recurse structurally and keep whatever arrived. A scalar on an
 *   open path is kept as-is, because it may simply be mid-arrival.
 *
 * This is what separates "the field has not streamed in yet" from "the field
 * arrived and is wrong". `partial-json` alone cannot tell them apart: it will
 * happily close the braces of a truncated string.
 */
export function buildSnapshot(
  value: unknown,
  schema: z.ZodType,
  tracker: CompletenessLookup,
  path = "",
): SnapshotResult {
  if (tracker.isComplete(path)) {
    try {
      const parsed = schema.safeParse(value)
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, value: undefined }
    } catch {
      // An async refinement (llmRefine) cannot run during a synchronous parse
      // and Zod throws. Streaming never reasks, so keep the raw value instead
      // of failing the whole snapshot.
      return { ok: true, value }
    }
  }

  const inner = unwrap(schema)
  const kind = def(inner).kind

  if (kind === "object" && isPlainObject(value)) {
    const shape = (inner as z.ZodObject<z.ZodRawShape>).shape
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const fieldSchema = shape[key]
      if (fieldSchema === undefined) {
        // Unknown key: keep it, the schema has nothing to say about it.
        out[key] = child
        continue
      }
      // v4 types shape fields as core $ZodType; narrow to the classic type.
      const built = buildSnapshot(
        child,
        fieldSchema as z.ZodType,
        tracker,
        path ? `${path}.${key}` : key,
      )
      if (built.ok) {
        out[key] = built.value
      }
    }
    return { ok: true, value: out }
  }

  if (kind === "array" && Array.isArray(value)) {
    const element = (def(inner).element ?? def(inner).type) as z.ZodType
    const out: unknown[] = []
    value.forEach((item, index) => {
      const built = buildSnapshot(item, element, tracker, `${path}[${index}]`)
      if (built.ok) {
        out.push(built.value)
      }
    })
    return { ok: true, value: out }
  }

  return { ok: true, value }
}
