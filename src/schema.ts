import { z, type ZodTypeAny } from "zod"

/** JSON Schema subset emitted for LLM tool / json_schema payloads. */
export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  enum?: Array<string | number | boolean | null>
  description?: string
  anyOf?: JsonSchema[]
  format?: string
}

type ZodDef = {
  typeName: string
  innerType?: ZodTypeAny
  schema?: ZodTypeAny
  type?: ZodTypeAny
  description?: string
  values?: string[]
  checks?: Array<{ kind: string }>
  options?: ZodTypeAny[] | Map<string, ZodTypeAny>
  value?: string | number | boolean
  valueType?: ZodTypeAny
  keyType?: ZodTypeAny
}

function def(schema: ZodTypeAny): ZodDef {
  return schema._def as ZodDef
}

/**
 * Convert a Zod schema into JSON Schema.
 *
 * Supports objects, arrays, unions, records, dates (ISO strings),
 * string, number, int, boolean, enum, literal, optional, and nullable.
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
    case "ZodLiteral":
      return convertLiteral(def(schema).value)
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return { anyOf: unionOptions(schema).map((option) => jsonSchemaFromZod(option)) }
    case "ZodRecord": {
      const valueType = def(schema).valueType
      if (!valueType) {
        throw new Error('ZodRecord is missing valueType')
      }
      return {
        type: "object",
        additionalProperties: jsonSchemaFromZod(valueType),
      }
    }
    case "ZodDate":
      return { type: "string", format: "date-time" }
    default:
      throw new Error(
        `Unsupported Zod type "${typeName}". Supported: object, array, union, record, date, string, number, int, boolean, enum, literal, optional, nullable.`,
      )
  }
}

function convertLiteral(value: string | number | boolean | undefined): JsonSchema {
  if (typeof value === "string") {
    return { type: "string", enum: [value] }
  }
  if (typeof value === "number") {
    return { type: "number", enum: [value] }
  }
  if (typeof value === "boolean") {
    return { type: "boolean", enum: [value] }
  }
  throw new Error("Unsupported Zod literal value")
}

function unionOptions(schema: ZodTypeAny): ZodTypeAny[] {
  const options = def(schema).options
  if (Array.isArray(options)) {
    return options
  }
  if (options instanceof Map) {
    return [...options.values()]
  }
  throw new Error("Zod union is missing options")
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
  let value = json
  if (isRootArray(schema)) {
    if (
      !Array.isArray(value) &&
      value !== null &&
      typeof value === "object" &&
      ROOT_ARRAY_KEY in value
    ) {
      value = (value as { items: unknown }).items
    }
  }
  return coerceBySchema(schema, value)
}

function coerceBySchema(schema: ZodTypeAny, json: unknown): unknown {
  const { inner, nullable } = unwrap(schema)
  if (json === null && nullable) {
    return null
  }
  const typeName = def(inner).typeName

  if (typeName === "ZodDate") {
    if (json instanceof Date) {
      return json
    }
    if (typeof json === "string" || typeof json === "number") {
      const date = new Date(json)
      if (!Number.isNaN(date.getTime())) {
        return date
      }
    }
    return json
  }

  if (typeName === "ZodObject" && json !== null && typeof json === "object" && !Array.isArray(json)) {
    const shape = (inner as z.ZodObject<z.ZodRawShape>).shape
    const record = json as Record<string, unknown>
    const out: Record<string, unknown> = { ...record }
    for (const [key, field] of Object.entries(shape)) {
      if (key in record) {
        out[key] = coerceBySchema(field, record[key])
      }
    }
    return out
  }

  if (typeName === "ZodArray" && Array.isArray(json)) {
    const element = def(inner).type as ZodTypeAny
    return json.map((item) => coerceBySchema(element, item))
  }

  if (typeName === "ZodRecord" && json !== null && typeof json === "object" && !Array.isArray(json)) {
    const valueType = def(inner).valueType
    if (!valueType) {
      return json
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
      out[key] = coerceBySchema(valueType, value)
    }
    return out
  }

  if (typeName === "ZodUnion" || typeName === "ZodDiscriminatedUnion") {
    for (const option of unionOptions(inner)) {
      const coerced = coerceBySchema(option, json)
      if (option.safeParse(coerced).success) {
        return coerced
      }
    }
    return json
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
  if (typeName === "ZodUnion" || typeName === "ZodDiscriminatedUnion") {
    const options = unionOptions(inner).map((option) => deepPartialZod(option)) as [
      ZodTypeAny,
      ZodTypeAny,
      ...ZodTypeAny[],
    ]
    return z.union(options)
  }
  if (typeName === "ZodRecord") {
    const valueType = def(inner).valueType
    return valueType ? z.record(deepPartialZod(valueType)) : inner
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
