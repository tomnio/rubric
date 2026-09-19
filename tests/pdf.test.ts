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
import { extractPdfPages } from "../src/pdf/index.js"

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
