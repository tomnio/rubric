# Long documents: `createDocument()`

This page is the full reference for the document pipeline. The [README](../README.md#documents) covers the shape and the quick example; [benchmarks.md](benchmarks.md) covers the correctness study. Everything here is behavior, not narrative.

`create()` takes one prompt. `createDocument()` takes a whole **document**: it splits the text, runs the same extraction on each chunk, and merges the results into one object. It lives behind a separate entry point so that importing the core does not pull in a WASM chunker.

```bash
pnpm add @chonkiejs/core   # optional, only needed for createDocument()
```

Full working example: [`examples/extract-document.ts`](../examples/extract-document.ts) (`pnpm example:extract-document`).

```ts
import { createDocument } from "@tomnio/rubric/document"
import { z } from "zod"

const Invoice = z.object({
  title: z.string(),
  items: z.array(z.object({ description: z.string(), amount: z.number() })),
})

// A chunk usually holds only part of the document, so validate chunks with a
// tolerant schema and keep `schema` strict for the merged result.
const ChunkInvoice = z.object({
  title: z.string().nullable().default(null),
  items: z.array(z.object({ description: z.string(), amount: z.number() })).default([]),
})

const { data, chunks, usage } = await createDocument(client, {
  model: "gpt-5.6-luna",
  document: longText,
  instruction: "Extract the invoice header and every line item.",
  schema: Invoice,
  chunkSchema: ChunkInvoice,
  chunkSize: 2000,   // characters, not tokens
  overlap: 100,      // characters bled outward on each side
  tokenBudget: 50_000, // whole document, every chunk and reask
})

data.title     // merged, validated against Invoice
chunks[0]      // { index, startIndex, endIndex, value, usage }
```

`startIndex` / `endIndex` are absolute offsets into the document you passed in, so you can trace any value back to where it came from.

`createDocument()` takes the same options as `create()` (`maxRetries`, `mode`, `temperature`, `max_tokens`, `top_p`, `signal`, `tokenBudget`, `timeout`, `hooks`) — with `tokenBudget` and `timeout` widened to the whole document — plus:

| Option | Default | Meaning |
|---|---|---|
| `document` | — | The plain text to extract from. |
| `instruction` | — | Sent to the model alongside each chunk. |
| `chunkSize` | `2000` | Target characters per chunk. |
| `overlap` | `100` | Characters bled outward on each side, for boundary recovery. |
| `chunkSchema` | `schema` | Schema used to validate each chunk. Pass a chunk-tolerant one. |
| `chunker` | Chonkie | Replace the splitter. See **Chunking** below. |
| `onChunkError` | `"skip"` | `"skip"` records the failure and continues; `"abort"` throws. |
| `chunkTokenBudget` | — | Cumulative token cap for **each** chunk, on top of `tokenBudget`. |
| `dedupe` | `"overlap"` | How to treat a repeat two chunks reported. See below. |
| `dedupeBy` | — | Field(s) that identify the same array item across chunks, so a reworded entity merges instead of doubling. See below. |
| `onConflict` | `"first"` | How to treat two chunks that reported different values for one field. See below. |

`tokenBudget` is measured across the **whole document**, not per chunk: it spans every chunk and every reask, so `tokenBudget: 50_000` on a 100-chunk document is 50k tokens total. It is checked *before* each chunk, so it blocks the next chunk rather than discarding one already paid for — a document whose final chunk crosses the budget is still returned, and the error carries the document-wide `usage`. Pass `chunkTokenBudget` as well to also cap each chunk individually; a chunk that reaches it fails and is handled by `onChunkError` like any other chunk failure. `timeout` follows the same shape: one deadline for the **whole document**, started once and shared by every chunk, so `timeout: 30_000` on a 100-chunk document is 30 seconds total rather than 30 seconds each. When the budget or the deadline cuts the run short — or the caller's `signal` aborts — the call throws `DocumentInterruptedError`, and everything extracted before the cut rides on the error: `partial` holds the completed chunks merged best-effort (not schema-validated, possibly incomplete), `chunks` holds their provenance, and `usage` the spend so far. The original interrupting error (`TimeoutError`, `AbortError`, `TokenBudgetExceeded`, `TokenUsageUnavailableError`) stays on `cause`. `maxRetries` is validated up front, before any chunk runs, so a bad value fails once with `TypeError` / `RangeError` instead of being buried in a per-chunk error.

> **Behaviour change.** `tokenBudget` on `createDocument()` used to be applied to **each chunk**; it now covers the whole document. If you were relying on a per-chunk cap, use `chunkTokenBudget`.

**Per-chunk hooks.** Hooks fire during the call, so they cannot wait for `result.chunks[]`. Every hook's `AttemptMeta` therefore carries a `chunk` descriptor for the chunk that fired it:

```ts
await createDocument(client, {
  ...,
  hooks: {
    onSuccess(_value, meta) {
      if (meta.chunk) {
        console.log(`extracted chunk ${meta.chunk.index + 1}/${meta.chunk.total}`)
      }
    },
  },
})
```

Use `meta.chunk.index`, **not** a counter you increment per hook call. `attemptNumber` counts attempts within a chunk and resets at each chunk boundary, so a chunk that reasks emits several events — a counter would report "chunk 6" for a two-chunk document. `total` is included so progress needs no up-front chunk count.

**Chunking.** The default chunker is `RecursiveChunker` from `@chonkiejs/core`, which splits on paragraph, then sentence, then punctuation. Its default tokenizer is character-based, so `chunkSize` counts **characters**. `overlap` widens each chunk's window over the original text, so content cut at a boundary still appears whole in one of the overlapping windows. Pass your own `chunker` to split differently.

A `Chunker` only **splits and positions** — it does not apply `overlap`. `createDocument()` widens whatever chunks come back, so boundary recovery works for every chunker, including one that ignores overlap entirely. `overlap` is deliberately **not** passed to a chunker (its options are just `{ chunkSize }`), because a chunker that widened its own windows would be widened a second time. If you are migrating a custom chunker that used to widen, delete that step; it now happens for you.

**Merging is deterministic and does not call the model.** The strategy follows the schema's root shape:

| Root | Rule |
|---|---|
| object | Array **fields** are concatenated across chunks; every other field takes the first non-null value seen, in chunk order. |
| array | The per-chunk arrays are concatenated the same way. |
| scalar (`z.string()`, `z.date()`, ...) | The first non-null value wins. |

**Scalar conflicts: keep the first, or fail?** "First non-null wins" is the default because chunk order roughly follows document order, so the first value is usually the one you want. But it can hide a real disagreement — the document may say one thing in one place and another later, and the default reports neither. Pass `onConflict: "error"` to throw `DocumentConflictError` instead, listing every field the chunks disagreed on and every value each one reported (with the window it was read from):

```ts
try {
  await createDocument(client, { ..., onConflict: "error" })
} catch (err) {
  if (err instanceof DocumentConflictError) {
    for (const c of err.conflicts) {
      console.log(c.key, c.values)   // [{ value, startIndex, endIndex }, ...]
    }
  }
}
```

Two chunks that **agree** are never a conflict — equality is the same structural comparison array dedupe uses, so overlapping windows that read the same text (the common case) pass. A nested object is an **atomic** value, so two different ones are a conflict; `null` counts as **absence**, not a value, so a chunk-tolerant schema (which reports unseen fields as `null`) does not conflict with a chunk that saw the field; and array fields are **exempt** — they concatenate, so there is nothing to choose between.

**Array fields: when is a repeat removed?** A value that more than one chunk reported is dropped only when those chunks' windows **overlap** — overlapping windows read the same text, so they are two views of one item. The default is `dedupe: "overlap"`:

```ts
await createDocument(client, { ..., dedupe: "none" })   // keep every repeat
```

| Case | Result |
|---|---|
| The same item inside **one** chunk | **Kept.** Windowing cannot have caused it — one window is one reading. |
| The same item in two chunks whose windows **overlap** | Counted once. This is the artifact `overlap` creates. |
| The same item in two chunks whose windows **do not** overlap | **Kept.** Two windows that share no text are two sightings. |

`dedupe: "none"` skips all of this and concatenates. Use it when the document may legitimately repeat an item (two identical invoice lines) and you would rather see a duplicate than lose one.

**Entity keys: merging a reworded item.** The rules above compare whole values, so an entity the model **reworded** across a boundary — `{ sku: "A1", desc: "Coffee" }` in one chunk, `{ sku: "A1", price: 5 }` in the next — is deep-unequal and survives twice, each copy holding half the fields. Name the field that identifies the entity to have the merge recognise the two readings as one item and **union their fields**:

```ts
await createDocument(client, { ..., dedupeBy: "sku" })          // or ["region", "sku"]
// → items: [{ sku: "A1", desc: "Coffee", price: 5 }]
```

Each field the first reading is missing is filled from the later one; a field both saw keeps the **first** non-null value, the same rule a scalar field follows. `dedupe` still applies — two readings merge only when their windows overlap. An item missing any named field, or holding it as `null`, is not identifiable and falls back to whole-value equality: it stays a separate item rather than being folded into one it may not match. The option is off by default, so it is purely additive.

What this means in practice:

- A value **reworded** in two chunks (same meaning, different text) is *not* merged — you get both, unless you name an entity key with `dedupeBy`.
- A conflicting scalar keeps the **first** value and silently discards the later one (unless you pass `onConflict: "error"`).
- A record longer than `overlap` that straddles a boundary can still be lost.
- **Known limit:** two genuine duplicates that happen to sit in two *overlapping* chunks are still collapsed — overlapping windows leave no signal to tell them apart from an overlap repeat. Use `dedupe: "none"` if that matters.

**Deep equality** compares type and content, so `z.date()`, `Map`, `Set` and `RegExp` values are compared as values: two `Date`s are equal only if they hold the same instant, and `NaN` is distinct from `null`. A value with no structural form — a class instance, a function — is opaque and equal only to itself, so an unrecognised duplicate survives rather than a distinct value disappearing.

There is deliberately no LLM "reduce" pass. A second, unvalidated model call would be nondeterministic and would reopen the failure modes `create()` exists to close.

**Failures.** A chunk that exhausts its retries is recorded on `chunks[i].error` and skipped by default; the rest of the document still merges. Pass `onChunkError: "abort"` to throw on the first failure instead. An aborted `signal` always propagates.

**Interruptions.** A `signal` abort, an elapsed `timeout`, or an exhausted document `tokenBudget` stops the run mid-way. Nothing already extracted is lost: the call throws `DocumentInterruptedError`, whose `partial` is the completed chunks merged best-effort (not schema-validated, possibly incomplete — treat as provisional), whose `chunks` carries their provenance, and whose `usage` the spend so far. The original error (`AbortError`, `TimeoutError`, `TokenBudgetExceeded`, `TokenUsageUnavailableError`) is on `cause`.

**Nothing succeeded** — every chunk failed, or the document was blank so no chunk ran — throws `DocumentNoDataError`, which carries `reason` (`"all-chunks-failed"` or `"empty-document"`), the `chunkErrors`, and the `usage` already spent. A blank document with an all-optional schema is not a valid empty answer; it is a question that was never asked. Only one chunk needs to succeed for the normal return.

**Merged output that fails `schema`** (a required field in no chunk, or two chunks contributing incompatible values) throws `DocumentMergeError`, which carries `issues`, the invalid `partial` object, and any `chunkErrors`. This is a different failure from `DocumentNoDataError`: the chunks *did* produce values, so the problem is their combination.

**Cost.** Each chunk is a separate `create()` call, so a document of N chunks costs N calls — up to `N × (maxRetries + 1)`. `tokenBudget` caps the total across all of them; `chunkTokenBudget` caps any one of them.

Requires Node 20+. The chunker is a WASM module, so it does not run on older Node.
