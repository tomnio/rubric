import type { z } from "zod"

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
  /** v3: "ZodObject"-style class name; v4: "object"-style kind string. */
  typeName?: string
  /** v4 kind string ("object", "array", …); v3 inner schema slot. */
  type?: string | z.ZodType
  /** v4 array element. */
  element?: z.ZodType
  innerType?: z.ZodType
  schema?: z.ZodType
  description?: string
  /** v3 literal value. v4 puts an array on `values` instead. */
  value?: string | number | boolean
  /** v3 enum values; v4 literal values. */
  values?: string[]
  /** v4 enum entries map (value -> value). */
  entries?: Record<string, string | number>
  checks?: Array<{ kind?: string; def?: { check?: string; format?: string } }>
  options?: z.ZodType[] | Map<string, z.ZodType>
  valueType?: z.ZodType
  keyType?: z.ZodType
}

/**
 * Normalized view of a schema's internals, spanning zod 3 and zod 4.
 *
 * The two versions name the same concepts differently: v3 puts
 * `"ZodObject"`-style names on `_def.typeName`, v4 puts `"object"`-style kind
 * strings on `_def.type`. Every consumer reads the normalized `kind` instead of
 * touching `_def` directly, so one mapping table covers both.
 */
type NormalizedDef = ZodDef & {
  /** v3 typeName with the "Zod" prefix stripped ("object", "array", …). */
  kind: string
}

const KIND_BY_TYPE_NAME: Record<string, string> = {
  ZodString: "string",
  ZodNumber: "number",
  ZodNaN: "number",
  ZodBoolean: "boolean",
  ZodEnum: "enum",
  ZodNativeEnum: "enum",
  ZodLiteral: "literal",
  ZodObject: "object",
  ZodArray: "array",
  ZodUnion: "union",
  ZodDiscriminatedUnion: "union",
  ZodRecord: "record",
  ZodDate: "date",
  ZodOptional: "optional",
  ZodNullable: "nullable",
  ZodDefault: "default",
  ZodEffects: "effects",
  ZodBranded: "branded",
}

function def(schema: z.ZodType): NormalizedDef {
  const raw = schema._def as ZodDef
  // v4: _def.type is the kind string. v3: _def.type is the inner schema (the
  // same slot v4 uses for array elements), so the typeof check tells them
  // apart and _def.typeName carries the kind instead.
  const v4Kind = typeof raw.type === "string" ? raw.type : undefined
  const kind =
    v4Kind ??
    (raw.typeName ? (KIND_BY_TYPE_NAME[raw.typeName] ?? raw.typeName) : "unknown")
  // v4 stores .describe() on the schema instance, not on _def; v3 keeps it in
  // both. Normalize to raw.description so every consumer can read it there.
  const instanceDescription = (schema as { description?: string }).description
  if (raw.description === undefined && instanceDescription !== undefined) {
    raw.description = instanceDescription
  }
  return { ...raw, kind }
}

/**
 * Convert a Zod schema into JSON Schema.
 *
 * Supports objects, arrays, unions, records, dates (ISO strings),
 * string, number, int, boolean, enum, literal, optional, and nullable.
 */
export function jsonSchemaFromZod(schema: z.ZodType): JsonSchema {
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

function unwrap(schema: z.ZodType): {
  inner: z.ZodType
  optional: boolean
  nullable: boolean
} {
  let inner = schema
  let optional = false
  let nullable = false

  for (;;) {
    const kind = def(inner).kind
    if (kind === "optional") {
      optional = true
      inner = def(inner).innerType as z.ZodType
      continue
    }
    if (kind === "nullable") {
      nullable = true
      inner = def(inner).innerType as z.ZodType
      continue
    }
    if (kind === "default") {
      inner = def(inner).innerType as z.ZodType
      continue
    }
    if (kind === "effects") {
      // v3: a refinement wraps the base schema in ZodEffects. v4: the refined
      // schema keeps its own kind and carries the checks, so this branch only
      // fires on v3.
      inner = def(inner).schema as z.ZodType
      continue
    }
    if (kind === "branded") {
      inner = def(inner).innerType as z.ZodType
      continue
    }
    break
  }

  return { inner, optional, nullable }
}

function convert(schema: z.ZodType): JsonSchema {
  const kind = def(schema).kind

  switch (kind) {
    case "string":
      return { type: "string" }
    case "number": {
      const isInt = isIntegerSchema(schema)
      return { type: isInt ? "integer" : "number" }
    }
    case "boolean":
      return { type: "boolean" }
    case "enum":
      return { type: "string", enum: enumValues(def(schema)) }
    case "object":
      return convertObject(schema as z.ZodObject<z.ZodRawShape>)
    case "array": {
      const element = arrayElement(schema)
      return { type: "array", items: jsonSchemaFromZod(element) }
    }
    case "literal":
      return convertLiteral(def(schema))
    case "union":
      return { anyOf: unionOptions(schema).map((option) => jsonSchemaFromZod(option)) }
    case "record": {
      const valueType = def(schema).valueType
      if (!valueType) {
        throw new Error('ZodRecord is missing valueType')
      }
      return {
        type: "object",
        additionalProperties: jsonSchemaFromZod(valueType),
      }
    }
    case "date":
      return { type: "string", format: "date-time" }
    default:
      throw new Error(
        `Unsupported Zod type "${kind}". Supported: object, array, union, record, date, string, number, int, boolean, enum, literal, optional, nullable.`,
      )
  }
}

/**
 * The array element schema, across versions: v4 calls it `_def.element`,
 * v3 calls it `_def.type`.
 */
function arrayElement(schema: z.ZodType): z.ZodType {
  const d = def(schema)
  const element = (d.element ?? d.type) as z.ZodType | undefined
  if (!element) {
    throw new Error("ZodArray is missing its element schema")
  }
  return element
}

/**
 * Whether a number schema is an integer, across versions: v4 exposes `.isInt`
 * on the schema itself, v3 marks it with a `kind: "int"` check.
 */
function isIntegerSchema(schema: z.ZodType): boolean {
  const self = schema as { isInt?: boolean }
  if (typeof self.isInt === "boolean") {
    return self.isInt
  }
  return (def(schema).checks ?? []).some((check) => check.kind === "int")
}

/**
 * Enum values, across versions: v3 keeps an array on `_def.values`, v4 keeps
 * a value->value map on `_def.entries`.
 */
function enumValues(defn: NormalizedDef): string[] {
  if (defn.values) {
    return [...defn.values]
  }
  if (defn.entries) {
    return Object.keys(defn.entries)
  }
  return []
}

/**
 * Literal schema to JSON Schema, across versions: v3 stores the single value
 * on `_def.value`, v4 stores a (usually one-element) array on `_def.values`.
 */
function convertLiteral(defn: NormalizedDef): JsonSchema {
  const value = defn.value ?? defn.values?.[0]
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

function unionOptions(schema: z.ZodType): z.ZodType[] {
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
export function llmJsonSchemaFromZod(schema: z.ZodType): JsonSchema {
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
export function coerceParsedValue(schema: z.ZodType, json: unknown): unknown {
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

function coerceBySchema(schema: z.ZodType, json: unknown): unknown {
  const { inner, nullable } = unwrap(schema)
  if (json === null && nullable) {
    return null
  }
  const kind = def(inner).kind

  if (kind === "date") {
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

  if (kind === "object" && json !== null && typeof json === "object" && !Array.isArray(json)) {
    const shape = (inner as z.ZodObject<z.ZodRawShape>).shape
    const record = json as Record<string, unknown>
    const out: Record<string, unknown> = { ...record }
    for (const [key, field] of Object.entries(shape)) {
      if (key in record) {
        // v4 types shape fields as core $ZodType; narrow to the classic type.
        out[key] = coerceBySchema(field as z.ZodType, record[key])
      }
    }
    return out
  }

  if (kind === "array" && Array.isArray(json)) {
    const element = arrayElement(inner)
    return json.map((item) => coerceBySchema(element, item))
  }

  if (kind === "record" && json !== null && typeof json === "object" && !Array.isArray(json)) {
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

  if (kind === "union") {
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

/** Root shape of a schema. The document merge picks its strategy from this. */
export type RootKind = "array" | "object" | "other"

/**
 * Classify a schema's root shape.
 *
 * Merging per-chunk results differs by root: arrays concatenate, objects merge
 * field by field, and anything else takes the first value. Reading the schema
 * is more reliable than inspecting runtime values, which cannot tell a
 * `z.date()` root apart from an object root.
 */
export function rootKind(schema: z.ZodType): RootKind {
  const kind = def(unwrap(schema).inner).kind
  if (kind === "array") {
    return "array"
  }
  if (kind === "object" || kind === "record") {
    return "object"
  }
  return "other"
}

function isRootArray(schema: z.ZodType): boolean {
  return rootKind(schema) === "array"
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const [key, field] of Object.entries(schema.shape)) {
    // v4 types shape fields as core $ZodType; narrow to the classic type.
    const fieldSchema = field as z.ZodType
    const { inner, optional, nullable } = unwrap(fieldSchema)
    const json = convert(inner)
    const description = def(fieldSchema).description ?? def(inner).description
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

/**
 * OpenAI `strict: true` rejects schemas Rubric still emits for TOOLS / MD_JSON.
 * Call this from JSON_SCHEMA prepare so we fail locally instead of at the API.
 */
export function assertOpenAiStrictSchema(schema: JsonSchema, path = "$"): void {
  if (schema.anyOf && schema.anyOf.length > 0) {
    const nonNull = schema.anyOf.filter((option) => option.type !== "null")
    const hasNull = schema.anyOf.some((option) => option.type === "null")
    if (schema.anyOf.length === 2 && hasNull && nonNull[0]) {
      assertOpenAiStrictSchema(nonNull[0], path)
      return
    }
    throw new Error(
      `JSON_SCHEMA strict: ${path} uses anyOf (union). OpenAI strict rejects this. Use TOOLS or MD_JSON, or a single object schema.`,
    )
  }

  if (schema.type === "array") {
    if (schema.items) {
      assertOpenAiStrictSchema(schema.items, `${path}[]`)
    }
    return
  }

  if (schema.type === "object") {
    if (schema.additionalProperties !== false) {
      throw new Error(
        `JSON_SCHEMA strict: ${path} is a record or open object (additionalProperties is not false). OpenAI strict rejects this. Use TOOLS or MD_JSON, or a fixed-key object.`,
      )
    }
    const properties = schema.properties ?? {}
    const required = new Set(schema.required ?? [])
    const optionalKeys = Object.keys(properties).filter((key) => !required.has(key))
    if (optionalKeys.length > 0) {
      throw new Error(
        `JSON_SCHEMA strict: ${path} has optional properties (${optionalKeys.join(", ")}) omitted from required. OpenAI strict requires every property in required. Use .nullable() instead of .optional(), or TOOLS / MD_JSON.`,
      )
    }
    for (const [key, value] of Object.entries(properties)) {
      assertOpenAiStrictSchema(value, `${path}.${key}`)
    }
  }
}
