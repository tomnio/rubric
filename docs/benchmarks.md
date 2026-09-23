# Benchmarks: lossless chunked extraction

The central claim of the document pipeline (`createDocument()`) is that cutting
a document into chunks, extracting each one, and merging the results **does not
lose, duplicate, or corrupt data**. This report measures that claim against
ground truth that is known exactly, and shows where the pipeline becomes the
only path that returns anything at all.

This is a correctness study, not a benchmark league table: one document shape,
one model, one seed. Everything here is reproducible from the repository — the
generator, the runner, and the commands are in `examples/`.

## Method

### Deterministic documents with planted answers

[`examples/lib/long-document.ts`](../examples/lib/long-document.ts) generates a
simulated quarterly operations report from a seeded PRNG (mulberry32). The same
seed produces byte-identical output on any machine, so every number below can
be re-derived exactly.

The generator plants known entities into the prose:

- **Planted transactions** (40 by default) — the scoring ground truth. Each has
  a unique SKU, description, amount, and region.
- **Reworded pairs** (~20% of planted) — the same transaction rendered twice
  with a paraphrased description and a different amount format
  (`$1,840.00` vs `USD 1,840`). The two copies are placed **exactly ±300
  characters around a chunk boundary** — beyond the default 100-character
  overlap, so each window sees exactly one copy. Reuniting them is only
  possible through the cross-chunk entity-key merge (`dedupeBy`). These pairs
  are booby traps for naive merging: a deep-equality dedupe keeps them as two
  items, and a window-unaware dedupe never sees both.
- **A scalar conflict** — the report header states `totalRevenue` as one value
  and a mid-document section revises it upward by 500k. No single chunk sees
  both, which is what `onConflict` guards.
- **Noise transactions** — every noise line carries a fresh, unique SKU, so any
  duplicate in the output can only come from windowing, never from the
  document itself.

### Scoring

[`scoreExtraction`](../examples/lib/long-document.ts) compares the extraction
output against the planted list:

- **recall** — fraction of planted entities recovered (same SKU, amount within
  1% to absorb format drift);
- **duplicateRate** — output items beyond the first per SKU, divided by output
  length. With unique noise SKUs this measures windowing double-counts and
  nothing else.

### Runs

Both approaches extract the same document with the same schema:

1. **naive** — one `create()` call with the whole document in the prompt;
2. **chunked** — `createDocument()` (chunkSize 4000, overlap 100,
   `dedupeBy: "sku"`, default `onConflict: "first"`).

Failures are reported, not hidden: a naive run that truncates or fails schema
validation is scored as what it returned.

## Results

Model: `gpt-5.6-luna` via an OpenAI-compatible gateway, MD_JSON mode.
Run date: 2026-09-16.

> `gpt-5.6-luna` is the gateway's name for the served model. What matters for
> this study is that both approaches used the same model, same mode, and same
> schema — the comparison is between pipelines, not models. Substitute any
> model via `OPENAI_MODEL`; the pipeline behavior (chunking, merge, truncation
> detection) is model-independent.

### 56 pages — inside the context window

```
document: 111,804 chars (~56 pages), 40 planted entities (8 reworded across chunk boundaries)
scalar conflict planted: totalRevenue = 4,200,000 vs 4,700,000

approach   chunks  items  recall  dupRate  tokens  wall
naive      1       502    100%    0%       n/a     98s
chunked    29      502    100%    0%       167k    462s
```

The chunked output has **exactly 502 items — the document's exact transaction
line count**. Nothing dropped, nothing doubled. All 8 boundary-straddling
reworded pairs were reunited into single items by `dedupeBy`. The planted
conflict resolved to the header value (first-wins, the documented default).

At this size the naive call also succeeds — the document fits in context. That
row winning is part of the design of the experiment: chunking earns its tokens
only past the context limit, which the next run shows.

### 151 pages — past the context limit

Same seed, same 40 planted entities, document scaled to 302,156 characters.

```
document: 302,156 chars (~151 pages), 40 planted entities (8 reworded across chunk boundaries)

approach   chunks  items  recall  dupRate  tokens  wall
naive      1       0      0%      0%       n/a     173s  (truncated)
chunked    77      1349   100%    0%       452k    1276s
```

The naive call died with `OutputTruncatedError` — the model's output limit cut
it off before any item was emitted, and rubric surfaced that as an error
instead of silently returning a partial list. Recall: 0%.

The chunked path recovered **all 40 planted entities at a 0% duplicate rate**
across 77 chunks, including the 8 reworded pairs.

### Reading the two runs together

| | inside context (56p) | past context (151p) |
|---|---|---|
| naive | 100% / 0% | **0%** (truncated) |
| chunked | 100% / 0% | **100% / 0%** |

Below the limit, either path works — chunking adds no loss. Past the limit,
chunking is the only path that returns anything. The pipeline's overhead is
tokens and wall time, never data.

## Reproduce

```bash
git clone https://github.com/tomnio/rubric && cd rubric
pnpm install
pnpm add -D tsx && pnpm add openai zod @chonkiejs/core

# 56-page run (the table above, seed 42)
OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=gpt-5.6-luna \
  pnpm example:extract-long-document

# 151-page run
OPENAI_API_KEY=... RUBRIC_EX_PAGES=150 pnpm example:extract-long-document

# cheap smoke first (4 pages, 8 entities)
RUBRIC_EX_SMOKE=1 OPENAI_API_KEY=... pnpm example:extract-long-document
```

The generator is covered by offline tests
([`tests/long-document.test.ts`](../tests/long-document.test.ts)): determinism,
reworded pairs straddling their boundary, no SKU appearing more than once in
the document, and exact scorer numbers on hand-built outputs.

## Threats to validity

- **One document shape.** A simulated quarterly report with transaction lists.
  Prose-dense documents (narrative, legal text) are not covered.
- **One model, one gateway.** Numbers will differ by model; the *claim* under
  test (no data loss through chunk+merge) is model-independent, but the
  recall numbers also depend on the model reading the chunks correctly.
- **One seed per size.** Not averaged across seeds; the generator is
  deterministic so the runs are exactly repeatable rather than sampled.
- **Boundary placement is adversarial by construction** — reworded copies sit
  ±300 chars from chunk boundaries. Real documents rarely arrange themselves
  this badly; a fixed chunker offset would evade them. That is intentional:
  the test is of the merge machinery, not the chunker's luck.
