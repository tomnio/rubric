/**
 * A chunk of a document, positioned in the ORIGINAL text.
 *
 * `startIndex` / `endIndex` are absolute offsets into the document the caller
 * passed in, not offsets into the chunk. Provenance depends on this: callers
 * use these to say "this data came from here in the document".
 */
export type DocumentChunk = {
  text: string
  startIndex: number
  endIndex: number
}

export type ChunkerOptions = {
  /** Target chunk size in characters (see `defaultChunker` on the unit). */
  chunkSize: number
}

/**
 * Split a document into positioned chunks.
 *
 * A chunker only splits and positions; it does **not** apply `overlap`. That is
 * the pipeline's job (`chunkDocument`), so boundary recovery works for every
 * chunker by construction rather than being each implementation's
 * responsibility to remember. This is why `overlap` is absent from
 * `ChunkerOptions`: a chunker that widened its own windows would be widened a
 * second time, so the option is kept out of reach.
 *
 * Injectable so tests can supply a deterministic splitter and never touch the
 * WASM chunker.
 */
export type Chunker = (
  document: string,
  options: ChunkerOptions,
) => Promise<DocumentChunk[]>

/**
 * Widen a chunk's window outward by `overlap` characters, clamped to the
 * document. This is how boundary recovery works: no chunker-level overlap
 * option exists, so we re-slice the original text instead of asking the
 * chunker for overlapping chunks.
 */
function widen(
  document: string,
  chunk: DocumentChunk,
  overlap: number,
): DocumentChunk {
  const startIndex = Math.max(0, chunk.startIndex - overlap)
  const endIndex = Math.min(document.length, chunk.endIndex + overlap)
  return {
    text: document.slice(startIndex, endIndex),
    startIndex,
    endIndex,
  }
}

/**
 * Default chunker, backed by `@chonkiejs/core`.
 *
 * Imported dynamically so that merely importing `@tomnio/rubric/document` does
 * not load the WASM module, and so users who never call it are not required to
 * install the optional peer dependency.
 *
 * The chunker's default tokenizer is character-based, so `chunkSize` is a
 * character count, not a token count.
 */
export const defaultChunker: Chunker = async (document, { chunkSize }) => {
  let RecursiveChunker: typeof import("@chonkiejs/core").RecursiveChunker
  try {
    ;({ RecursiveChunker } = await import("@chonkiejs/core"))
  } catch (cause) {
    throw new Error(
      "The default document chunker requires the optional dependency @chonkiejs/core. " +
        "Install it with `pnpm add @chonkiejs/core`, or pass a custom `chunker`.",
      { cause },
    )
  }

  const chunker = await RecursiveChunker.create({ chunkSize })
  const chunks = await chunker.chunk(document)
  return chunks.map((chunk) => ({
    text: chunk.text,
    startIndex: chunk.startIndex,
    endIndex: chunk.endIndex,
  }))
}

/**
 * Split `document` into positioned chunks, then widen every window by
 * `overlap`. The widening happens here rather than inside a chunker, so a
 * custom chunker gets boundary recovery without implementing it.
 *
 * Chunking a blank document yields no chunks.
 */
export async function chunkDocument(
  document: string,
  options: ChunkerOptions & { overlap: number; chunker?: Chunker },
): Promise<DocumentChunk[]> {
  if (document.trim().length === 0) {
    return []
  }
  const chunker = options.chunker ?? defaultChunker
  const chunks = await chunker(document, { chunkSize: options.chunkSize })
  if (options.overlap <= 0) {
    return chunks
  }
  return chunks.map((chunk) => widen(document, chunk, options.overlap))
}
