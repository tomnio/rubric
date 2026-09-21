/**
 * PDF entry-point contract and extraction behavior.
 *
 * Fixtures are built in-process with pdf-lib, so the suite stays offline and
 * deterministic: every page's text is known exactly at generation time.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { extractPdfPages, joinPages } from "../src/pdf/index.js"

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

interface PkgJson {
  type: string
  exports: Record<string, Record<string, string>>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
}

const pkg: PkgJson = JSON.parse(
  readFileSync(`${repoRoot}package.json`, "utf8"),
) as PkgJson

/** Build a PDF whose page n reads exactly `Page n: <text[n-1]>`. */
async function buildPdf(pageTexts: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const line of pageTexts) {
    const page = pdf.addPage([600, 800])
    page.drawText(line, { x: 50, y: 700, size: 14, font })
  }
  return pdf.save()
}

describe("pdf entry point", () => {
  it("declares both import and require conditions", () => {
    const entry = pkg.exports["./pdf"]
    expect(entry).toBeDefined()
    expect(entry?.["import"]).toBeTruthy()
    expect(entry?.["require"]).toBeTruthy()
  })

  it("is an optional peer pinned to the Node 20-compatible range", () => {
    expect(pkg.peerDependencies.unpdf).toBe(">=1.7.0 <1.8")
    expect(pkg.peerDependenciesMeta.unpdf?.optional).toBe(true)
  })
})

describe("extractPdfPages", () => {
  it("extracts every page in order with 1-based numbers", async () => {
    const pdf = await buildPdf([
      "INVOICE 2026-0042",
      "Consulting hours 1,200.00",
      "Travel reimbursement 340.50",
    ])
    const result = await extractPdfPages(pdf)

    expect(result.totalPages).toBe(3)
    expect(result.pages.map((p) => p.number)).toEqual([1, 2, 3])
    const [page1, page2, page3] = result.pages
    expect(page1?.text).toContain("INVOICE 2026-0042")
    expect(page2?.text).toContain("1,200.00")
    expect(page3?.text).toContain("340.50")
  })

  it("accepts an ArrayBuffer as well as a Uint8Array", async () => {
    const pdf = await buildPdf(["single page"])
    const buffer = pdf.buffer.slice(
      pdf.byteOffset,
      pdf.byteOffset + pdf.byteLength,
    ) as ArrayBuffer
    const result = await extractPdfPages(buffer)
    expect(result.totalPages).toBe(1)
    expect(result.pages[0]?.text).toContain("single page")
  })

  it("does not detach the caller's buffer — the same input works twice", async () => {
    // pdf.js transfers ownership of the buffer it is handed; without the
    // defensive copy the second call fails with
    // "Cannot transfer object of unsupported type".
    const pdf = await buildPdf(["reused buffer"])
    const first = await extractPdfPages(pdf)
    const second = await extractPdfPages(pdf)

    expect(first.totalPages).toBe(1)
    expect(second.totalPages).toBe(1)
    expect(second.pages[0]?.text).toContain("reused buffer")
  })

  it("rejects an empty buffer before touching the parser", async () => {
    await expect(extractPdfPages(new Uint8Array(0))).rejects.toThrow(
      /empty PDF buffer/,
    )
  })

  it("fails with an install hint when unpdf is absent — contract only", () => {
    // The dynamic-import fallback path is exercised by the package-entries
    // contract (unpdf is installed here); the hint text is pinned so the
    // error a user sees names the fix.
    expect(readFileSync(`${repoRoot}src/pdf/index.ts`, "utf8")).toMatch(
      /pnpm add unpdf/,
    )
  })
})

describe("joinPages", () => {
  it("records each page's exact span in the joined text", () => {
    const { text, spans } = joinPages([
      { number: 1, text: "alpha" },
      { number: 2, text: "beta" },
      { number: 3, text: "gamma" },
    ])

    // Default separator is one blank line between pages.
    expect(text).toBe("alpha\n\nbeta\n\ngamma")
    expect(spans).toEqual([
      { number: 1, startOffset: 0, endOffset: 5 },
      { number: 2, startOffset: 7, endOffset: 11 },
      { number: 3, startOffset: 13, endOffset: 18 },
    ])
    // Every span slices back to its own page text.
    for (const [i, span] of spans.entries()) {
      expect(text.slice(span.startOffset, span.endOffset)).toBe(
        ["alpha", "beta", "gamma"][i],
      )
    }
  })

  it("keeps offsets pointing inside pages, never at the separator", () => {
    // The separator belongs to neither span: any offset within a span is
    // page content. The gaps between spans are exactly the separators.
    const { text, spans } = joinPages([
      { number: 1, text: "a" },
      { number: 2, text: "b" },
    ], "\n")
    expect(text).toBe("a\nb")
    expect(text.slice(spans[0]!.endOffset, spans[1]!.startOffset)).toBe("\n")
  })

  it("handles empty pages and an empty page list", () => {
    const empty = joinPages([])
    expect(empty.text).toBe("")
    expect(empty.spans).toEqual([])

    const { text, spans } = joinPages([
      { number: 1, text: "" },
      { number: 2, text: "only" },
    ])
    expect(text).toBe("\n\nonly")
    expect(spans[0]).toEqual({ number: 1, startOffset: 0, endOffset: 0 })
    expect(spans[1]).toEqual({ number: 2, startOffset: 2, endOffset: 6 })
  })

  it("maps a character offset to its page — the createDocument use case", () => {
    // Simulates tracing a merged value's window back to a page number.
    const { text, spans } = joinPages([
      { number: 1, text: "revenue 4,200,000" },
      { number: 2, text: "sku A1 amount 5" },
    ])
    const pageOf = (offset: number) =>
      spans.find((s) => offset >= s.startOffset && offset < s.endOffset)?.number

    const idx = text.indexOf("A1")
    expect(text.slice(idx, idx + 2)).toBe("A1")
    expect(pageOf(idx)).toBe(2)
    expect(pageOf(text.indexOf("4,200,000"))).toBe(1)
    expect(pageOf(text.length)).toBeUndefined() // end offset is exclusive
  })
})
