import type { ZodTypeAny } from "zod"
import { JsonParseError, type SchemaValidationError } from "../errors.js"
import { jsonSchemaFromZod } from "../schema.js"
import type { RequestKwargs } from "../types.js"
import {
  choiceMessage,
  openaiContentDelta,
  parseJsonText,
  reaskWithUserMessage,
} from "./helpers.js"
import type { ModeHandler } from "./types.js"

/**
 * Take the LAST complete JSON span, not the first.
 *
 * The model's own answer comes last. JSON appearing earlier may have been
 * copied from the prompt — a source document, a previous turn — and a crafted
 * document could place a fake object there to hijack the parse.
 *
 * Scans for balanced `{}` / `[]` spans, skipping string contents, and returns
 * the last one that parses. Mirrors Python's `raw_decode` loop, where a value
 * ends at its closing bracket and trailing text is ignored.
 */
function lastJsonSpan(text: string): unknown | undefined {
  let last: unknown
  let found = false
  let index = 0

  while (index < text.length) {
    const char = text[index]
    if (char !== "{" && char !== "[") {
      index += 1
      continue
    }
    const end = matchingBracketEnd(text, index)
    if (end === -1) {
      index += 1
      continue
    }
    try {
      last = JSON.parse(text.slice(index, end + 1)) as unknown
      found = true
    } catch {
      // Balanced but not valid JSON (e.g. `{not json}`); keep scanning.
    }
    index = end + 1
  }

  return found ? last : undefined
}

/** Index of the bracket closing the one at `start`, or -1 if unbalanced. */
function matchingBracketEnd(text: string, start: number): number {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") {
      stack.push("}")
      continue
    }
    if (char === "[") {
      stack.push("]")
      continue
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) {
        return -1
      }
      if (stack.length === 0) {
        return index
      }
    }
  }

  return -1
}

function instruction(schema: ZodTypeAny): string {
  const jsonSchema = JSON.stringify(jsonSchemaFromZod(schema), null, 2)
  return [
    "Reply with only JSON inside a markdown fence:",
    "",
    "```json",
    "...",
    "```",
    "",
    "The JSON must match this schema:",
    jsonSchema,
  ].join("\n")
}

export const mdJsonHandler: ModeHandler = {
  prepareRequest(schema: ZodTypeAny, kwargs: RequestKwargs): RequestKwargs {
    return {
      ...kwargs,
      messages: [
        { role: "system", content: instruction(schema) },
        ...kwargs.messages,
      ],
    }
  },

  parseResponse(raw: unknown): unknown {
    const content = choiceMessage(raw)?.["content"]
    if (typeof content !== "string" || content.trim() === "") {
      throw new JsonParseError("Response has no JSON content", raw)
    }

    // The last valid span wins, whether or not it sits in a fence. Scanning the
    // whole message is what makes a prompt-embedded object unable to hijack the
    // result: the model's own answer is what comes last.
    const span = lastJsonSpan(content)
    if (span !== undefined) {
      return span
    }

    return parseJsonText(content, raw)
  },

  handleReask(
    kwargs: RequestKwargs,
    raw: unknown,
    error: JsonParseError | SchemaValidationError,
  ): RequestKwargs {
    return reaskWithUserMessage(kwargs, raw, error)
  },

  deltaFromChunk(raw: unknown): string {
    return openaiContentDelta(raw)
  },
}
