import { describe, expect, it } from "vitest"
import { z } from "zod"
import { jsonSchemaFromZod, llmJsonSchemaFromZod } from "../src/schema.ts"

describe("jsonSchemaFromZod", () => {
  it("converts a flat object with string and int", () => {
    const User = z.object({
      name: z.string(),
      age: z.number().int(),
    })

    expect(jsonSchemaFromZod(User)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name", "age"],
    })
  })

  it("converts nested objects", () => {
    const Profile = z.object({
      user: z.object({
        name: z.string(),
      }),
    })

    expect(jsonSchemaFromZod(Profile)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        user: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
      required: ["user"],
    })
  })

  it("omits optional fields from required", () => {
    const Model = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    })

    const schema = jsonSchemaFromZod(Model)
    expect(schema.required).toEqual(["name"])
    expect(schema.properties?.["nickname"]).toEqual({ type: "string" })
  })

  it("encodes nullable fields as anyOf null", () => {
    const Model = z.object({
      name: z.string().nullable(),
    })

    expect(jsonSchemaFromZod(Model).properties?.["name"]).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    })
    expect(jsonSchemaFromZod(Model).required).toEqual(["name"])
  })

  it("converts enums, booleans, and floats", () => {
    const Model = z.object({
      role: z.enum(["admin", "user"]),
      active: z.boolean(),
      score: z.number(),
    })

    expect(jsonSchemaFromZod(Model).properties).toEqual({
      role: { type: "string", enum: ["admin", "user"] },
      active: { type: "boolean" },
      score: { type: "number" },
    })
  })

  it("copies .describe() onto the JSON Schema", () => {
    const Model = z.object({
      name: z.string().describe("Display name"),
    })

    expect(jsonSchemaFromZod(Model).properties?.["name"]).toEqual({
      type: "string",
      description: "Display name",
    })
  })

  it("converts arrays of primitives and objects", () => {
    expect(jsonSchemaFromZod(z.array(z.string()))).toEqual({
      type: "array",
      items: { type: "string" },
    })

    const Users = z.array(
      z.object({
        name: z.string(),
        age: z.number().int(),
      }),
    )
    expect(jsonSchemaFromZod(Users)).toEqual({
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
        required: ["name", "age"],
      },
    })
  })

  it("converts nested and optional arrays on objects", () => {
    const Model = z.object({
      tags: z.array(z.string()),
      groups: z.array(z.array(z.number())).optional(),
    })
    const schema = jsonSchemaFromZod(Model)
    expect(schema.properties?.["tags"]).toEqual({
      type: "array",
      items: { type: "string" },
    })
    expect(schema.properties?.["groups"]).toEqual({
      type: "array",
      items: { type: "array", items: { type: "number" } },
    })
    expect(schema.required).toEqual(["tags"])
  })

  it("wraps a root array as { items } for LLM object roots", () => {
    expect(llmJsonSchemaFromZod(z.array(z.string()))).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        items: { type: "array", items: { type: "string" } },
      },
      required: ["items"],
    })
  })

  it("converts unions and discriminated unions to anyOf", () => {
    const Pet = z.union([
      z.object({ kind: z.literal("dog"), bark: z.boolean() }),
      z.object({ kind: z.literal("cat"), lives: z.number() }),
    ])
    const schema = jsonSchemaFromZod(Pet)
    expect(schema.anyOf).toHaveLength(2)
    expect(schema.anyOf?.[0]).toMatchObject({
      properties: { kind: { type: "string", enum: ["dog"] } },
    })

    const Tagged = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("dog"), bark: z.boolean() }),
      z.object({ kind: z.literal("cat"), lives: z.number() }),
    ])
    expect(jsonSchemaFromZod(Tagged).anyOf).toHaveLength(2)
  })

  it("converts records and dates", () => {
    expect(jsonSchemaFromZod(z.record(z.number()))).toEqual({
      type: "object",
      additionalProperties: { type: "number" },
    })
    expect(jsonSchemaFromZod(z.date())).toEqual({
      type: "string",
      format: "date-time",
    })
  })

  it("throws on unsupported Zod types", () => {
    expect(() => jsonSchemaFromZod(z.map(z.string(), z.string()))).toThrow(
      /Unsupported Zod type/,
    )
  })
})
