import { z, type ZodTypeAny } from "zod"

/**
 * Wrap a schema so extraction can report a miss instead of failing.
 *
 * Use as `create({ schema: maybe(User), ... })`.
 */
export function maybe<T extends ZodTypeAny>(schema: T) {
  return z.object({
    result: schema
      .nullable()
      .describe("Extracted value if present in the input, otherwise null"),
    error: z
      .boolean()
      .describe("True when no value could be extracted from the input"),
    message: z
      .string()
      .nullable()
      .describe("Short reason when error is true, otherwise null"),
  })
}
