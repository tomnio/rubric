/**
 * Live PDF extraction example. Not part of default CI.
 *
 *   OPENAI_API_KEY=... pnpm example:extract-pdf
 *   PDF_PATH=/path/to/file.pdf OPENAI_API_KEY=... pnpm example:extract-pdf
 *
 * Without PDF_PATH it generates a small multi-page invoice PDF in-memory,
 * so the example runs end to end without any fixture file.
 *
 * Requires the optional peers: pnpm add unpdf @chonkiejs/core
 */
import OpenAI from "openai"
import { z } from "zod"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { readFile } from "node:fs/promises"
import { extractPdfPages, joinPages } from "../src/pdf/index.ts"
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

// A chunk holds only part of the document, so chunks validate loosely and
// the merged result validates strictly against Invoice.
const ChunkInvoice = z.object({
  title: z.string().nullable().default(null),
  items: z
    .array(z.object({ description: z.string(), amount: z.number() }))
    .default([]),
})

/** Build a small invoice PDF spanning three pages, with known content. */
async function buildInvoicePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const lines = [
    "INVOICE 2026-0042",
    "Billed to: Acme GmbH, Berlin",
    "",
    "Line items:",
    "1. Consulting hours, March .......... 1200.00",
    "2. Travel reimbursement ............. 340.50",
    "3. Software licence (annual) ........ 899.00",
    "",
    "Payment due within 30 days.",
  ]
  // One page every three lines, so the pipeline sees several pages.
  for (let i = 0; i < lines.length; i += 3) {
    const page = pdf.addPage([600, 800])
    for (const [row, line] of lines.slice(i, i + 3).entries()) {
      page.drawText(line, { x: 50, y: 700 - row * 30, size: 14, font })
    }
  }
  return pdf.save()
}

const apiKey = process.env["OPENAI_API_KEY"]
if (!apiKey) {
  console.error("Set OPENAI_API_KEY to run this example.")
  process.exit(1)
}

const pdfPath = process.env["PDF_PATH"]
const pdfBytes = pdfPath
  ? new Uint8Array(await readFile(pdfPath))
  : await buildInvoicePdf()
console.log(
  pdfPath
    ? `Extracting text from ${pdfPath}...`
    : "No PDF_PATH set; using a generated 3-page invoice PDF...",
)

// First mile: PDF → per-page text.
const { totalPages, pages } = await extractPdfPages(pdfBytes)
console.log(`Got ${totalPages} page(s).`)

// Join the pages and hand the text to the existing document pipeline.
// `spans` records where each page landed in the joined text — the same
// coordinate space `createDocument()` reports chunk offsets in — so any
// chunk's window can be traced back to its page.
const { text: document, spans } = joinPages(pages)
const client = new OpenAI({
  apiKey,
  ...(process.env["OPENAI_BASE_URL"]
    ? { baseURL: process.env["OPENAI_BASE_URL"] }
    : {}),
})

const result = await createDocument(client, {
  model: process.env["OPENAI_MODEL"] ?? "gpt-5.6-luna",
  document,
  instruction: "Extract the invoice title and every line item (description, amount).",
  schema: Invoice,
  chunkSchema: ChunkInvoice,
  mode: "MD_JSON",
})

console.log("\nMerged, validated result:")
console.log(JSON.stringify(result.data, null, 2))
console.log(`\n${result.chunks.length} chunk(s), ${result.usage.totalTokens} tokens`)

// Page provenance: map each chunk's character window back to its page(s).
const pageOf = (offset: number) =>
  spans.find((s) => offset >= s.startOffset && offset < s.endOffset)?.number
for (const chunk of result.chunks) {
  const first = pageOf(chunk.startIndex) ?? "?"
  const last = pageOf(Math.max(0, chunk.endIndex - 1)) ?? "?"
  console.log(
    `chunk [${chunk.startIndex}, ${chunk.endIndex}) → page(s) ${first}-${last}`,
  )
}
