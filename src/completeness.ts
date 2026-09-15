import { parse as parsePartialJson } from "partial-json"

/**
 * Which subtrees of a half-arrived JSON string are closed.
 *
 * A streaming snapshot is a mix of finished and unfinished data. Without this,
 * `{"name": "Alice", "address": {"city": "NY` and `...{"city": "NYC"}` look
 * the same once `partial-json` has closed the braces for us — so a truncated
 * `"NY"` gets treated as a final value.
 *
 * The rule is the sibling heuristic: a value that has a next sibling must have
 * finished parsing, because the parser had to reach the following comma or
 * bracket to find that sibling. Only the last sibling is unknown, so it is
 * recursed into instead of trusted.
 */
export type CompletenessLookup = {
  isComplete(path: string): boolean
}

/** Paths use `user.address.city` for objects and `items[0]` for arrays. Root is `""`. */
export class JsonCompleteness implements CompletenessLookup {
  private complete = new Set<string>()

  /** Recompute completeness for the accumulated text. Safe to call every frame. */
  analyze(text: string): void {
    this.complete = new Set()
    const trimmed = text.trim()
    if (trimmed === "") {
      return
    }

    // Strict parse first: if it succeeds the whole structure is closed.
    try {
      this.markAll(JSON.parse(trimmed) as unknown, "")
      return
    } catch {
      // Incomplete JSON — fall through to the sibling heuristic.
    }

    let partial: unknown
    try {
      partial = parsePartialJson(trimmed) as unknown
    } catch {
      return
    }
    this.checkSiblings(partial, "")
  }

  isComplete(path: string): boolean {
    return this.complete.has(path)
  }

  isRootComplete(): boolean {
    return this.complete.has("")
  }

  getCompletePaths(): string[] {
    return [...this.complete]
  }

  /** Mark a closed subtree and everything under it. */
  private markAll(value: unknown, path: string): void {
    this.complete.add(path)
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.markAll(item, `${path}[${index}]`))
      return
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        this.markAll(child, path ? `${path}.${key}` : key)
      }
    }
  }

  /** Recurse into the last sibling, trusting every earlier one. */
  private checkSiblings(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const childPath = `${path}[${index}]`
        if (index < value.length - 1) {
          this.markAll(item, childPath)
        } else {
          this.checkSiblings(item, childPath)
        }
      })
      return
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value)
      keys.forEach((key, index) => {
        const childPath = path ? `${path}.${key}` : key
        if (index < keys.length - 1) {
          this.markAll(value[key], childPath)
        } else {
          this.checkSiblings(value[key], childPath)
        }
      })
    }
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
