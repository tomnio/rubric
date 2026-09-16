import { z, type ZodObject, type ZodRawShape } from "zod"
import { currentContext } from "./context.js"

const CITATION_FIELD = "substring_quotes"

const CITATION_FIELD_DESCRIPTION =
  "Unique, specific substrings copied verbatim from the provided context. " +
  "Every quote must appear in the context exactly as written."

type Span = { start: number; end: number }

/**
 * Add a verified `substring_quotes` field to an object schema.
 *
 * The model fills the field with quotes from the source text. On parse, each
 * quote is matched against `context` (passed to `create()`); unmatched quotes
 * become validation issues and reask, matched ones are rewritten to the exact
 * source substring.
 *
 * Without a `context`, the field passes through unchecked.
 *
 * The generic is over the shape, not the object: parameterising by
 * `ZodObject<ZodRawShape>` loses the concrete shape through `extend()` and the
 * return type degrades to `unknown`, so callers would have to cast the result
 * of `create()` to read `substring_quotes`. Taking `ZodObject<T>` keeps the
 * inferred output typed.
 */
export function cited<T extends ZodRawShape>(schema: ZodObject<T>) {
  const extended = schema.extend({
    [CITATION_FIELD]: z.array(z.string()).describe(CITATION_FIELD_DESCRIPTION),
  })

  return extended.superRefine((raw, ctx) => {
    const context = currentContext().citation
    if (context === undefined) {
      return
    }
    // Indexing by CITATION_FIELD needs a plain record: superRefine's inferred
    // value type (extended + Omit intersections) doesn't expose a static key.
    const value = raw as Record<string, unknown>
    const quotes = value[CITATION_FIELD]
    if (!Array.isArray(quotes)) {
      return
    }

    const corrected: string[] = []
    for (const [index, quote] of quotes.entries()) {
      const span = findQuoteSpan(quote, context)
      if (span === undefined) {
        corrected.push(quote)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [CITATION_FIELD, index],
          message:
            `Quote is not a substring of the provided context: ${JSON.stringify(truncate(quote))}. ` +
            "Copy an exact span from the context.",
        })
        continue
      }
      corrected.push(context.slice(span.start, span.end))
    }

    // Rewrite in place so a successful parse returns real source spans rather
    // than the model's transcription. Zod returns this same object on success.
    value[CITATION_FIELD] = corrected
  })
}

/**
 * Locate `quote` in `source`, exactly or after whitespace/case normalization.
 * Returns offsets into the original `source`, so callers can slice real text.
 */
function findQuoteSpan(quote: string, source: string): Span | undefined {
  const needle = quote.trim()
  if (needle.length === 0) {
    return undefined
  }

  const exact = source.indexOf(needle)
  if (exact >= 0) {
    return { start: exact, end: exact + needle.length }
  }

  const haystack = normalize(source)
  const normalizedNeedle = normalize(needle)
  if (normalizedNeedle.text.length === 0) {
    return undefined
  }
  const at = haystack.text.indexOf(normalizedNeedle.text)
  if (at < 0) {
    return undefined
  }

  const start = haystack.map[at]
  const lastStart = haystack.map[at + normalizedNeedle.text.length - 1]
  if (start === undefined || lastStart === undefined) {
    return undefined
  }
  return { start, end: lastStart + charLengthAt(source, lastStart) }
}

const WHITESPACE = /\s/

/**
 * Lowercase and collapse every whitespace run to a single space, keeping a map
 * from each normalized character back to its offset in the original string.
 */
function normalize(text: string): { text: string; map: number[] } {
  let out = ""
  const map: number[] = []
  let index = 0

  while (index < text.length) {
    const char = text[index] as string
    if (WHITESPACE.test(char)) {
      let end = index
      while (end < text.length && WHITESPACE.test(text[end] as string)) {
        end += 1
      }
      out += " "
      map.push(index)
      index = end
      continue
    }
    for (const lowered of char.toLowerCase()) {
      out += lowered
      map.push(index)
    }
    index += 1
  }

  return { text: out, map }
}

/** UTF-16 length of the code point starting at `index` (2 for astral chars). */
function charLengthAt(text: string, index: number): number {
  const code = text.codePointAt(index)
  return code !== undefined && code > 0xffff ? 2 : 1
}

function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}
