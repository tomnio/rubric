import { z, type ZodTypeAny } from "zod"

/** JSON Schema subset emitted for LLM tool / json_schema payloads. */
export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
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
 * Supports objects (including nested), arrays, string, number, int, boolean,
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
    case "ZodArray": {
      const element = def(schema).type as ZodTypeAny
      return { type: "array", items: jsonSchemaFromZod(element) }
    }
    default:
      throw new Error(
        `Unsupported Zod type "${typeName}". Supported: object, array, string, number, int, boolean, enum, optional, nullable.`,
      )
  }
}

const ROOT_ARRAY_KEY = "items"

/**
 * OpenAI tools / json_schema require a root object.
 * Root arrays are wrapped as `{ items: T[] }`.
 */
export function llmJsonSchemaFromZod(schema: ZodTypeAny): JsonSchema {
  const json = jsonSchemaFromZod(schema)
  if (json.type !== "array") {
    return json
  }
  return {
    type: "object",
    properties: { [ROOT_ARRAY_KEY]: json },
    required: [ROOT_ARRAY_KEY],
    additionalProperties: false,
  }
}

/** If the schema is a root array, accept either `T[]` or `{ items: T[] }`. */
export function coerceParsedValue(schema: ZodTypeAny, json: unknown): unknown {
  if (!isRootArray(schema)) {
    return json
  }
  if (Array.isArray(json)) {
    return json
  }
  if (json !== null && typeof json === "object" && ROOT_ARRAY_KEY in json) {
    return (json as { items: unknown }).items
  }
  return json
}

function isRootArray(schema: ZodTypeAny): boolean {
  return def(unwrap(schema).inner).typeName === "ZodArray"
}

/** All object fields optional, recursively. Used to hydrate streaming snapshots. */
export function deepPartialZod(schema: ZodTypeAny): ZodTypeAny {
  const { inner } = unwrap(schema)
  const typeName = def(inner).typeName
  if (typeName === "ZodObject") {
    const shape: z.ZodRawShape = {}
    for (const [key, field] of Object.entries(
      (inner as z.ZodObject<z.ZodRawShape>).shape,
    )) {
      shape[key] = deepPartialZod(field).optional()
    }
    return z.object(shape)
  }
  if (typeName === "ZodArray") {
    const element = def(inner).type as ZodTypeAny
    return z.array(deepPartialZod(element))
  }
  return inner
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
