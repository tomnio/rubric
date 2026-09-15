import type { z, ZodTypeAny } from "zod"
import { isPlainObject, type CompletenessLookup } from "./completeness.js"

type ZodDef = {
  typeName: string
  innerType?: ZodTypeAny
  schema?: ZodTypeAny
  type?: ZodTypeAny
}

function def(schema: ZodTypeAny): ZodDef {
  return schema._def as ZodDef
}

/** Strip optional / nullable / default / effects wrappers to reach the shape. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let inner = schema
  for (;;) {
    const typeName = def(inner).typeName
    if (
      typeName === "ZodOptional" ||
      typeName === "ZodNullable" ||
      typeName === "ZodDefault"
    ) {
      inner = def(inner).innerType as ZodTypeAny
      continue
    }
    if (typeName === "ZodEffects") {
      inner = def(inner).schema as ZodTypeAny
      continue
    }
    if (typeName === "ZodBranded") {
      inner = def(inner).type as ZodTypeAny
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
  schema: ZodTypeAny,
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
  const typeName = def(inner).typeName

  if (typeName === "ZodObject" && isPlainObject(value)) {
    const shape = (inner as z.ZodObject<z.ZodRawShape>).shape
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const fieldSchema = shape[key]
      if (fieldSchema === undefined) {
        // Unknown key: keep it, the schema has nothing to say about it.
        out[key] = child
        continue
      }
      const built = buildSnapshot(
        child,
        fieldSchema,
        tracker,
        path ? `${path}.${key}` : key,
      )
      if (built.ok) {
        out[key] = built.value
      }
    }
    return { ok: true, value: out }
  }

  if (typeName === "ZodArray" && Array.isArray(value)) {
    const element = def(inner).type as ZodTypeAny
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
