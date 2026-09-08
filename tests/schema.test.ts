import { describe, expect, it } from "vitest"
import { z } from "zod"
import { jsonSchemaFromZod } from "../src/schema.ts"

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

  it("throws on unsupported Zod types", () => {
    expect(() => jsonSchemaFromZod(z.date())).toThrow(/Unsupported Zod type/)
    expect(() => jsonSchemaFromZod(z.array(z.string()))).toThrow(/Unsupported Zod type/)
  })
})
