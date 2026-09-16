/**
 * Live long-document example. Not part of default CI.
 *
 *   OPENAI_API_KEY=... pnpm example:extract-long-document
 *
 * Generates a ~55-page simulated quarterly report with KNOWN planted
 * entities, then runs the same extraction two ways and scores both:
 *
 *   1. naive — one create() call with the whole document in the prompt
 *   2. chunked — createDocument() with per-chunk extraction and merge
 *
 * The report prints recall (fraction of planted entities recovered),
 * duplicate rate, token usage and wall time for each approach.
 *
 * Cheap iteration: RUBRIC_EX_SMOKE=1 (4 pages, 8 planted entities).
 * Scale overrides: RUBRIC_EX_PAGES, RUBRIC_EX_PLANTED, RUBRIC_EX_SEED.
 * Conflict guardrail demo: RUBRIC_EX_CONFLICT=error makes the chunked run
 * throw DocumentConflictError instead of keeping the first value.
 *
 * Requires the optional chunker: pnpm add @chonkiejs/core
 */
import OpenAI from "openai"
import { z } from "zod"
import { createDocument, DocumentConflictError } from "../src/document/index.ts"
import {
  generateLongDocument,
  scoreExtraction,
  type ExtractionOutput,
} from "./lib/long-document.ts"

const apiKey = process.env["OPENAI_API_KEY"]
if (!apiKey) {
  console.error("Set OPENAI_API_KEY to run this example.")
  process.exit(1)
}
const baseURL = process.env["OPENAI_BASE_URL"]
const model = process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna"

const smoke = process.env["RUBRIC_EX_SMOKE"] === "1"
const pages = smoke
  ? 4
  : Number(process.env["RUBRIC_EX_PAGES"] ?? "55")
const plantedCount = smoke
  ? 8
  : Number(process.env["RUBRIC_EX_PLANTED"] ?? "40")
const seed = Number(process.env["RUBRIC_EX_SEED"] ?? "42")
const conflictMode =
  process.env["RUBRIC_EX_CONFLICT"] === "error" ? "error" : "first"

// --- Ground truth ---------------------------------------------------------
// chunkSize must match the generator's placement assumption: reworded copies
// straddle multiples of this value.
const CHUNK_SIZE = smoke ? 2000 : 4000
const doc = generateLongDocument({ seed, pages, plantedCount, chunkSize: CHUNK_SIZE })

const reworded = doc.planted.filter((tx) => tx.kind === "reworded").length
console.log(
  `document: ${doc.charCount.toLocaleString()} chars (~${Math.round(doc.charCount / 2000)} pages), ` +
    `${doc.planted.length} planted entities (${reworded} reworded across chunk boundaries), ` +
    `seed ${seed}`,
)
console.log(
  `scalar conflict planted: totalRevenue = ${doc.scalarConflicts[0]?.values[0]?.toLocaleString()} ` +
    `vs ${doc.scalarConflicts[0]?.values[1]?.toLocaleString()}`,
)

// --- Schemas --------------------------------------------------------------
// Strict: what the merged result (and the naive call) must satisfy.
const Report = z.object({
  totalRevenue: z.number(),
  transactions: z
    .array(
      z.object({
        sku: z.string(),
        description: z.string(),
        amount: z.number(),
        region: z.string(),
      }),
    )
    .min(1),
})

// Chunk-tolerant: one chunk rarely sees the header, and amounts may be cut
// off. sku stays required — it is the dedupeBy entity key.
const ChunkReport = z.object({
  totalRevenue: z.number().nullable().default(null),
  transactions: z
    .array(
      z.object({
        sku: z.string(),
        description: z.string().default(""),
        amount: z.number().nullable().default(null),
        region: z.string().default(""),
      }),
    )
    .default([]),
})

const instruction =
  "Extract the report's total revenue and every transaction line " +
  "(sku, description, amount in dollars, region). " +
  "Skip lines that are cut off or incomplete — do not guess missing values."

// --- Runners --------------------------------------------------------------
interface RunOutcome {
  name: string
  items: ExtractionOutput[]
  totalRevenue: number | null
  error: string | null
  chunks: number
  tokens: number
  wallMs: number
}

async function runNaive(client: OpenAI): Promise<RunOutcome> {
  const { wrap } = await import("../src/index.ts")
  const wrapped = wrap(client, { mode: "MD_JSON" })
  const start = Date.now()
  try {
    const data = await wrapped.create({
      model,
      schema: Report,
      messages: [{ role: "user", content: `${instruction}\n\n---\n\n${doc.text}` }],
    })
    return {
      name: "naive",
      items: data.transactions,
      totalRevenue: data.totalRevenue,
      error: null,
      chunks: 1,
      tokens: 0,
      wallMs: Date.now() - start,
    }
  } catch (error) {
    return {
      name: "naive",
      items: [],
      totalRevenue: null,
      error: error instanceof Error ? error.message : String(error),
      chunks: 1,
      tokens: 0,
      wallMs: Date.now() - start,
    }
  }
}

async function runChunked(client: OpenAI): Promise<RunOutcome> {
  const start = Date.now()
  try {
    const result = await createDocument(
      client,
      {
        model,
        document: doc.text,
        instruction,
        schema: Report,
        chunkSchema: ChunkReport,
        chunkSize: CHUNK_SIZE,
        overlap: 100,
        dedupeBy: "sku",
        onConflict: conflictMode,
      },
      { mode: "MD_JSON" },
    )
    return {
      name: "chunked",
      items: result.data.transactions,
      totalRevenue: result.data.totalRevenue,
      error: null,
      chunks: result.chunks.length,
      tokens: result.usage.totalTokens,
      wallMs: Date.now() - start,
    }
  } catch (error) {
    if (error instanceof DocumentConflictError) {
      const fields = error.conflicts
        .map((c) => `${c.key}: ${c.values.map((v) => String(v.value)).join(" vs ")}`)
        .join("; ")
      return {
        name: "chunked",
        items: [],
        totalRevenue: null,
        error: `DocumentConflictError (onConflict: "error") — ${fields}`,
        chunks: 0,
        tokens: 0,
        wallMs: Date.now() - start,
      }
    }
    return {
      name: "chunked",
      items: [],
      totalRevenue: null,
      error: error instanceof Error ? error.message : String(error),
      chunks: 0,
      tokens: 0,
      wallMs: Date.now() - start,
    }
  }
}

// --- Main -----------------------------------------------------------------
const client = baseURL
  ? new OpenAI({ apiKey, baseURL })
  : new OpenAI({ apiKey })

console.log("\nrunning naive (single call over the whole document)...")
const naive = await runNaive(client)
console.log("running chunked (createDocument)...")
const chunked = await runChunked(client)

const score = (run: RunOutcome) => scoreExtraction(doc.planted, run.items)
const naiveScore = score(naive)
const chunkedScore = score(chunked)

const pct = (x: number) => `${(x * 100).toFixed(0)}%`
console.log("\napproach   chunks  items  recall  dupRate  tokens    wall")
for (const run of [naive, chunked]) {
  const s = score(run)
  const tokens = run.tokens > 0 ? `${(run.tokens / 1000).toFixed(0)}k` : "-"
  console.log(
    `${run.name.padEnd(10)} ${String(run.chunks).padEnd(7)} ${String(run.items.length).padEnd(6)} ` +
      `${pct(s.recall).padEnd(7)} ${pct(s.duplicateRate).padEnd(8)} ${tokens.padEnd(9)} ` +
      `${(run.wallMs / 1000).toFixed(1)}s`,
  )
  if (run.error !== null) {
    console.log(`${run.name} error: ${run.error}`)
  }
}

console.log(`\nplanted: ${doc.planted.length} (naive recovered ${naiveScore.recovered}, chunked recovered ${chunkedScore.recovered})`)
if (naive.totalRevenue !== null || chunked.totalRevenue !== null) {
  const [a, b] = doc.scalarConflicts[0]?.values ?? []
  console.log(
    `totalRevenue planted: ${a?.toLocaleString()} / ${b?.toLocaleString()} — ` +
      `naive: ${naive.totalRevenue?.toLocaleString() ?? "n/a"}, ` +
      `chunked (${conflictMode}): ${chunked.totalRevenue?.toLocaleString() ?? "n/a"}`,
  )
}
