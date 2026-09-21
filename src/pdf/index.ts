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

/** A page's span within the text produced by `joinPages`. */
export type PageSpan = {
  /** 1-based page number, matching the source `PdfPage`. */
  number: number
  /** Inclusive start offset of this page's text in the joined string. */
  startOffset: number
  /** Exclusive end offset of this page's text in the joined string. */
  endOffset: number
}

export type JoinedPages = {
  /** The text to pass as `createDocument()`'s `document`. */
  text: string
  /**
   * Each page's span within `text`, in page order. Offsets are absolute
   * into `text`, the same coordinate space `createDocument()` reports in
   * its per-chunk `startIndex` / `endIndex` and conflict entries — so a
   * merged value's window can be mapped back to the page it came from.
   */
  spans: PageSpan[]
}

/**
 * Join per-page text into one document string, recording where each page
 * landed. `createDocument()` traces values to character offsets in the text
 * it was given; `spans` is what turns those offsets into page numbers:
 *
 * ```ts
 * const { text, spans } = joinPages(pages)
 * const { chunks } = await createDocument(client, { document: text, ... })
 * const pageOf = (offset: number) =>
 *   spans.find((s) => offset >= s.startOffset && offset < s.endOffset)?.number
 * ```
 */
export function joinPages(
  pages: PdfPage[],
  separator = "\n\n",
): JoinedPages {
  const spans: PageSpan[] = []
  let cursor = 0
  let text = ""
  for (const [i, page] of pages.entries()) {
    if (i > 0) {
      // The separator sits between pages and belongs to neither span, so
      // an offset that falls inside a span is unambiguously inside a page.
      text += separator
      cursor += separator.length
    }
    const startOffset = cursor
    text += page.text
    cursor += page.text.length
    spans.push({ number: page.number, startOffset, endOffset: cursor })
  }
  return { text, spans }
}
