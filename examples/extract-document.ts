/**
 * Live document extraction example. Not part of default CI.
 *
 *   OPENAI_API_KEY=... pnpm example:extract-document
 *
 * Requires the optional chunker: pnpm add @chonkiejs/core
 */
import OpenAI from "openai"
import { z } from "zod"
import { createDocument } from "../src/document/index.ts"

const Invoice = z.object({
  title: z.string(),
  items: z.array(
    z.object({
      description: z.string(),
      amount: z.number(),
    }),
  ),
})

// A chunk holds only part of the document, so chunks validate loosely and the
// merged result validates strictly against Invoice.
const ChunkInvoice = z.object({
  title: z.string().nullable().default(null),
  items: z
    .array(z.object({ description: z.string(), amount: z.number() }))
    .default([]),
})

const DOCUMENT = `
INVOICE 2026-0042
Billed to: Acme GmbH, Berlin

Line items:
1. Consulting hours, March ......... 1,200.00
2. Travel reimbursement ............   340.50
3. Software licence (annual) .......   899.00

Payment due within 30 days.
`.trim()

const apiKey = process.env["OPENAI_API_KEY"]
if (!apiKey) {
  console.error("Set OPENAI_API_KEY to run this example.")
  process.exit(1)
}

const baseURL = process.env["OPENAI_BASE_URL"]
const openai = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey })

const result = await createDocument(
  openai,
  {
    model: process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna",
    document: DOCUMENT,
    instruction: "Extract the invoice title and every line item.",
    schema: Invoice,
    chunkSchema: ChunkInvoice,
    chunkSize: 120,
    overlap: 40,
  },
  { mode: "TOOLS" },
)

console.log("data:", result.data)
console.log("chunks:", result.chunks.length)
console.log("usage:", result.usage)
for (const chunk of result.chunks) {
  console.log(`  [${chunk.startIndex}-${chunk.endIndex}]`, chunk.value ?? chunk.error?.message)
}
