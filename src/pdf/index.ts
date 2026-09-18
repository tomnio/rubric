/**
 * PDF → text, the first mile of the document pipeline.
 *
 * `createDocument()` takes plain text; most real-world documents arrive as
 * PDF. This entry point extracts per-page text so the result can be fed
 * straight into `createDocument()`. Text layer only — a scanned page has no
 * text layer and comes back as an empty string; there is no OCR here.
 *
 * Backed by `unpdf`, an optional peer: importing this module never loads it,
 * and calling `extractPdfPages()` without it installed fails with an
 * install hint. Pinned to 1.7.x because 1.8+ declares `node >= 22` while
 * this package supports Node 20.
 */
/// <reference types="node" />

const INSTALL_HINT =
  "PDF extraction requires the optional dependency unpdf. " +
  "Install it with `pnpm add unpdf` (version 1.7.x — 1.8+ requires Node 22)."

/** One page's text. `number` is 1-based, matching the PDF page order. */
export type PdfPage = {
  number: number
  text: string
}

export type PdfPagesResult = {
  /** Total pages reported by the PDF itself. */
  totalPages: number
  /** Every page in order, including ones with no text layer (empty `text`). */
  pages: PdfPage[]
}

/**
 * Extract the text of each page of a PDF.
 *
 * The input is copied before it reaches the parser: pdf.js takes ownership
 * of the buffer it is handed (it transfers it to a worker), so reusing the
 * same Uint8Array across two calls would fail with
 * "Cannot transfer object of unsupported type". Copying here makes the
 * caller's buffer safe to reuse — passing the same file buffer twice works.
 *
 * Returns pages, not one merged string: how to join pages (separator,
 * header/footer cleanup) is the caller's call. The common case is
 * `pages.map((p) => p.text).join("\n\n")` into `createDocument()`.
 */
export async function extractPdfPages(
  input: Uint8Array | ArrayBuffer,
): Promise<PdfPagesResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength === 0) {
    throw new Error("Cannot extract text from an empty PDF buffer")
  }

  // Defensive copy: see the doc comment. `bytes` itself may be a view the
  // caller still holds, so copy from it rather than detaching it.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)

  let unpdf: typeof import("unpdf")
  try {
    unpdf = await import("unpdf")
  } catch (error) {
    throw new Error(INSTALL_HINT, { cause: error })
  }

  const { totalPages, text } = await unpdf.extractText(copy, {
    mergePages: false,
  })
  const pageTexts = Array.isArray(text) ? text : [text]

  return {
    totalPages,
    pages: pageTexts.map((text, i) => ({ number: i + 1, text })),
  }
}
