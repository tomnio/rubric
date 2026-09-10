import { parse as parsePartialJson } from "partial-json"

export function jsonSlice(buffer: string): string {
  const fence = buffer.match(/```(?:json)?\s*([\s\S]*)$/i)
  if (fence?.[1] !== undefined) {
    return fence[1]
  }
  const start = buffer.search(/[{[]/)
  return start >= 0 ? buffer.slice(start) : buffer
}

export function parseIncomplete(buffer: string): unknown {
  const slice = jsonSlice(buffer).trim()
  if (slice === "") {
    return undefined
  }
  try {
    return parsePartialJson(slice) as unknown
  } catch {
    return undefined
  }
}
