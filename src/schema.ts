import { z, type ZodTypeAny } from "zod"

/** JSON Schema subset emitted for LLM tool / json_schema payloads. */
export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  enum?: Array<string | number | null>
  description?: string
  anyOf?: JsonSchema[]
}

type ZodDef = {
  typeName: string
  innerType?: ZodTypeAny
  schema?: ZodTypeAny
  type?: ZodTypeAny
  description?: string
  values?: string[]
  checks?: Array<{ kind: string }>
}

function def(schema: ZodTypeAny): ZodDef {
  return schema._def as ZodDef
}

/**
 * Convert a Zod schema into JSON Schema.
 *
 * v0 supports objects (including nested), string, number, int, boolean,
 * enum, optional, and nullable. Other Zod types throw.
 */
export function jsonSchemaFromZod(schema: ZodTypeAny): JsonSchema {
  const { inner, optional, nullable } = unwrap(schema)
  const json = convert(inner)

  const description = def(schema).description ?? def(inner).description
  if (description !== undefined) {
    json.description = description
  }

  if (nullable) {
    return { anyOf: [json, { type: "null" }] }
  }

  // `optional` is used by object fields (omitted from `required`).
  void optional
  return json
}

function unwrap(schema: ZodTypeAny): {
  inner: ZodTypeAny
  optional: boolean
  nullable: boolean
} {
  let inner = schema
  let optional = false
  let nullable = false

  for (;;) {
    const typeName = def(inner).typeName
    if (typeName === "ZodOptional") {
      optional = true
      inner = def(inner).innerType as ZodTypeAny
      continue
    }
    if (typeName === "ZodNullable") {
      nullable = true
      inner = def(inner).innerType as ZodTypeAny
      continue
    }
    if (typeName === "ZodDefault") {
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

  return { inner, optional, nullable }
}

function convert(schema: ZodTypeAny): JsonSchema {
  const typeName = def(schema).typeName

  switch (typeName) {
    case "ZodString":
      return { type: "string" }
    case "ZodNumber": {
      const isInt = (def(schema).checks ?? []).some((check) => check.kind === "int")
      return { type: isInt ? "integer" : "number" }
    }
    case "ZodBoolean":
      return { type: "boolean" }
    case "ZodEnum":
      return { type: "string", enum: [...(def(schema).values ?? [])] }
    case "ZodObject":
      return convertObject(schema as z.ZodObject<z.ZodRawShape>)
    default:
      throw new Error(
        `Unsupported Zod type "${typeName}". v0 supports object, string, number, int, boolean, enum, optional, and nullable.`,
      )
  }
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const [key, field] of Object.entries(schema.shape)) {
    const { inner, optional, nullable } = unwrap(field)
    const json = convert(inner)
    const description = def(field).description ?? def(inner).description
    if (description !== undefined) {
      json.description = description
    }
    properties[key] = nullable ? { anyOf: [json, { type: "null" }] } : json
    if (!optional) {
      required.push(key)
    }
  }

  const result: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  }
  if (required.length > 0) {
    result.required = required
  }
  return result
}
