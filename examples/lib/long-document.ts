/**
 * Deterministic long-document generator and extraction scorer.
 *
 * Pure module: no network, no environment access, safe to import from tests.
 * The generator plants known entities in a simulated quarterly report so an
 * extraction run can be scored exactly: recall against ground truth, plus a
 * duplicate rate that shows whether overlapping chunks double-counted items.
 *
 * Everything is drawn from a seeded PRNG (mulberry32), so the same options
 * produce byte-identical output across runs and machines.
 */

/** Deterministic PRNG: fast, seedable, same sequence everywhere. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GenOptions {
  /** Seed for the PRNG. Same seed, same document. Default: 42. */
  seed?: number
  /** Target document size in pages of ~2000 characters. Default: 55. */
  pages?: number
  /** How many transactions to plant as scoreable ground truth. Default: 40. */
  plantedCount?: number
  /**
   * Chunk size the extraction will use, so "reworded" copies can be placed
   * across a chunk boundary. The generator only uses this for placement; the
   * caller must pass the same value to createDocument(). Default: 4000.
   */
  chunkSize?: number
}

/** One planted transaction: the ground truth a run is scored against. */
export interface PlantedTx {
  sku: string
  description: string
  amount: number
  region: string
  /**
   * "stable" appears once; "reworded" appears twice — same sku, paraphrased
   * description, differently formatted amount — with the copies straddling a
   * chunk boundary, so only an entity-key merge collapses them into one.
   */
  kind: "stable" | "reworded"
}

/**
 * A scalar field two distant sections report differently. Scalar conflicts
 * are what onConflict guards: array fields are exempt (they concatenate) and
 * an entity-key merge resolves transaction-level disagreements silently, so
 * the conflict has to live on a plain field.
 */
export interface ScalarConflict {
  field: "totalRevenue"
  values: [number, number]
}

export interface GeneratedDoc {
  text: string
  planted: PlantedTx[]
  scalarConflicts: ScalarConflict[]
  charCount: number
}

const REGIONS = ["NA", "EMEA", "APAC", "LATAM"] as const

const NOUNS = [
  "gauge aluminum bracket",
  "stainless fastener kit",
  "pressure valve assembly",
  "sealed bearing unit",
  "modular housing panel",
  "thermal gasket set",
  "copper grounding strip",
  "ceramic insulator ring",
  "hydraulic hose segment",
  "carbon steel flange",
] as const

const ADJECTIVES = [
  "heavy",
  "compact",
  "reinforced",
  "anodized",
  "polished",
  "standard",
  "industrial",
  "coated",
] as const

const FILLER_SENTENCES = [
  "Operations remained within the projected cost envelope for the quarter.",
  "Regional leads flagged logistics costs as the primary variance driver.",
  "Procurement consolidated vendors to improve lead times and pricing.",
  "Inventory turnover improved modestly compared with the prior period.",
  "The integration of the new tracking system concluded ahead of schedule.",
  "Demand in industrial segments held steady across all territories.",
  "Supplier audits were completed with no critical findings reported.",
  "Working capital requirements stayed close to the seasonal norm.",
  "Fulfillment accuracy reached its highest level in six quarters.",
  "Capital expenditure was redirected toward automation upgrades.",
] as const

const CHARS_PER_PAGE = 2000

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T
}

function formatMoney(value: number): string {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** The alternate rendering used for the second copy of a reworded item. */
function formatMoneyAlt(value: number): string {
  return `USD ${Math.round(value).toLocaleString("en-US")}`
}

function transactionLine(
  tx: PlantedTx,
  copy: "first" | "second",
  rng: () => number,
): string {
  const adjective = copy === "first" ? pick(rng, ADJECTIVES) : pick(rng, ADJECTIVES)
  const noun = tx.description
  const units = 1 + Math.floor(rng() * 48)
  const money =
    copy === "first" ? formatMoney(tx.amount) : formatMoneyAlt(tx.amount)
  const sku = copy === "first" ? tx.sku : tx.sku.replace(/^SKU-/, "SKU ")
  return `- ${sku} | ${adjective} ${noun}, ${units} units | ${money} | ${tx.region}`
}

/**
 * Generate the simulated quarterly report.
 *
 * "Reworded" transactions are placed in pairs around chunk boundaries: one
 * copy just before `i * chunkSize`, one just after, so overlapping windows
 * read both and a plain deep-equality dedupe keeps them as two items. The
 * scalar conflict is planted once in the header and once mid-document, where
 * no single chunk sees both.
 */
export function generateLongDocument(opts: GenOptions = {}): GeneratedDoc {
  const seed = opts.seed ?? 42
  const pages = opts.pages ?? 55
  const plantedCount = opts.plantedCount ?? 40
  const chunkSize = opts.chunkSize ?? 4000
  const rng = mulberry32(seed)

  const targetChars = pages * CHARS_PER_PAGE

  // Where reworded pairs can go: spread across distinct boundaries after the
  // first few thousand chars, one pair per boundary. Computed up front because
  // the count caps how many entities can be "reworded" — a small document may
  // not offer one boundary per pair.
  const rewordedShare = 0.2
  const rewordedTarget = Math.max(1, Math.round(plantedCount * rewordedShare))
  const boundaries: number[] = []
  for (let i = 1; boundaries.length < rewordedTarget; i++) {
    const boundary = i * chunkSize
    // Stop scanning once past the document: no further boundary can qualify.
    if (boundary >= targetChars) break
    if (boundary > 3000 && boundary < targetChars - chunkSize) {
      boundaries.push(boundary)
    }
  }
  const rewordedCount = Math.min(rewordedTarget, boundaries.length)

  // --- Ground truth -------------------------------------------------------
  const planted: PlantedTx[] = []
  const skuPool: string[] = []
  for (let i = 0; i < plantedCount; i++) {
    const sku = `SKU-${String(1000 + Math.floor(rng() * 9000)).padStart(4, "0")}`
    // Keep skus unique so scoring is unambiguous.
    if (skuPool.includes(sku)) {
      i--
      continue
    }
    skuPool.push(sku)
    const kind = planted.length < rewordedCount ? "reworded" : "stable"
    planted.push({
      sku,
      description: pick(rng, NOUNS),
      amount: Math.round((100 + rng() * 4900) * 100) / 100,
      region: pick(rng, REGIONS),
      kind,
    })
  }
  const plantedSkus = new Set(skuPool)

  // --- Conflict -----------------------------------------------------------
  const revenueA = Math.round((3_500_000 + rng() * 1_000_000) / 100_000) * 100_000
  const revenueB = revenueA + 500_000
  const scalarConflicts: ScalarConflict[] = [
    { field: "totalRevenue", values: [revenueA, revenueB] },
  ]

  // --- Document body ------------------------------------------------------
  const header = [
    "QUARTERLY OPERATIONS REPORT",
    "Meridian Industrial Group",
    `Reporting period: Q3 ${2024 + (seed % 5)}`,
    "",
    `Total Q3 revenue: ${formatMoney(revenueA)}`,
    "",
  ].join("\n")

  // Each reworded pair gets its own boundary — the pairs were sized to the
  // boundary list above, so no modulo sharing is needed.
  const reworded = planted.filter((tx) => tx.kind === "reworded")
  const rewordedPlacement = new Map<string, number>()
  reworded.forEach((tx, i) => {
    rewordedPlacement.set(tx.sku, boundaries[i] ?? 0)
  })

  let plantedCursor = 0
  // Interleave: iterate sections; each section emits filler prose, then either
  // a planted transaction (when one is due) or a noise transaction.
  // Noise skus are unique and drawn sequentially from a range disjoint from
  // the planted pool, so every noise sku appears in the document exactly once.
  // A repeated noise sku would be a genuine duplicate in the output, and the
  // duplicate-rate metric — which exists to expose windowing double-counts —
  // would measure the document instead of the extraction.
  // Noise skus come from a range disjoint from the planted pool (1000-9999).
  // Each noise line takes the next one, so every noise transaction appears in
  // the document exactly once and a duplicate in the output can only come from
  // windowing — which is what the duplicate-rate metric measures.
  let noiseCursor = 0
  const nextNoiseSku = (): string => {
    for (;;) {
      const sku = `SKU-${9000 + noiseCursor++}`
      if (!plantedSkus.has(sku)) return sku
    }
  }

  let chars = header.length

  // Emit the second conflict value roughly halfway through the document.
  let conflictPlaced = false

  let sectionIndex = 0

  // Reworded items are spliced at chunk boundaries afterwards, so the loop
  // only ever consumes "stable" ones; skip any reworded head of the queue.
  while (planted[plantedCursor]?.kind === "reworded") plantedCursor++

  const sections: string[] = []
  while (chars < targetChars || plantedCursor < planted.length) {
    sectionIndex++
    const section: string[] = []
    const region = pick(rng, REGIONS)
    section.push(`\nSection ${sectionIndex}: ${region} Regional Operations`)
    section.push("")

    // Prose filler paragraphs.
    for (let p = 0; p < 2; p++) {
      const sentences: string[] = []
      for (let s = 0; s < 3; s++) {
        sentences.push(pick(rng, FILLER_SENTENCES))
      }
      section.push(sentences.join(" "))
      section.push("")
    }

    // A transaction list: mostly noise, occasionally a planted item.
    const listItems = 2 + Math.floor(rng() * 3)
    for (let li = 0; li < listItems; li++) {
      const due = plantedCursor < planted.length && (li === 0 || rng() < 0.35)
      if (due) {
        const tx = planted[plantedCursor++] as PlantedTx
        section.push(transactionLine(tx, "first", rng))
        while (planted[plantedCursor]?.kind === "reworded") plantedCursor++
      } else {
        // A fresh sku per noise line: every noise transaction appears in the
        // document exactly once, so a duplicate in the output can only come
        // from windowing — which is what the duplicate-rate metric measures.
        const noise: PlantedTx = {
          sku: nextNoiseSku(),
          description: pick(rng, NOUNS),
          amount: Math.round((100 + rng() * 4900) * 100) / 100,
          region: pick(rng, REGIONS),
          kind: "stable",
        }
        section.push(transactionLine(noise, "first", rng))
      }
    }

    // Plant the second revenue figure in a section past the midpoint.
    if (!conflictPlaced && chars > targetChars / 2 && sectionIndex > 2) {
      section.push("")
      section.push(`Revised full-quarter revenue estimate: ${formatMoney(revenueB)}`)
      conflictPlaced = true
    }

    const block = section.join("\n")
    sections.push(block)
    chars += block.length
  }

  // Rebuild the text boundary by boundary with exact char accounting: the
  // base content is emitted line by line until the running length reaches
  // the next placement target, so the finished document has each reworded
  // pair starting at exactly C-300 and C+300 where C is a multiple of
  // chunkSize. The caller's chunk boundaries therefore genuinely fall
  // between the two copies, and the 600-char gap with the default 100-char
  // overlap means one chunk sees only the "first" copy and the next only
  // the "second": collapsing them takes a cross-chunk entity-key merge
  // (dedupeBy), which the pair exists to test.
  // The header is prepended here (not just counted in `chars`) so the first
  // revenue figure actually reaches the output text.
  const base = header + sections.join("\n")
  const baseLines = base.split("\n")
  const byBoundary = new Map<number, PlantedTx>()
  for (const tx of reworded) {
    byBoundary.set(rewordedPlacement.get(tx.sku) ?? 0, tx)
  }
  const placedBoundaries = [...byBoundary.keys()].sort((a, b) => a - b)
  let nextBoundaryTarget = placedBoundaries.shift()

  let text = ""
  let count = 0
  let baseCursor = 0


  const padWithBase = (target: number): void => {
    while (count < target && baseCursor < baseLines.length) {
      const line = baseLines[baseCursor++] as string
      text += line + "\n"
      count += line.length + 1
    }
  }
  const padWithBlank = (target: number): void => {
    // Only used if the base runs short of a target (tiny documents): pad
    // with a spacer line so exact offsets still hold.
    while (count < target) {
      text += "\n"
      count += 1
    }
  }
  const emitLine = (line: string): void => {
    text += line + "\n"
    count += line.length + 1
  }

  while (nextBoundaryTarget !== undefined) {
    if (nextBoundaryTarget - 300 > count) {
      padWithBase(nextBoundaryTarget - 300)
      padWithBlank(nextBoundaryTarget - 300)
    }
    emitLine(transactionLine(byBoundary.get(nextBoundaryTarget) as PlantedTx, "first", rng))
    // Fill the gap between the copies with base content (not padding) so
    // the text around the boundary reads naturally.
    if (nextBoundaryTarget + 300 > count) {
      padWithBase(nextBoundaryTarget + 300)
      padWithBlank(nextBoundaryTarget + 300)
    }
    emitLine(transactionLine(byBoundary.get(nextBoundaryTarget) as PlantedTx, "second", rng))
    nextBoundaryTarget = placedBoundaries.shift()
  }
  // Flush whatever base content remains.
  padWithBase(Infinity)
  text += baseLines.slice(baseCursor).join("\n")

  return {
    text,
    planted,
    scalarConflicts,
    charCount: text.length,
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ExtractionOutput {
  sku: string
  amount: number
}

export interface Metrics {
  /** Ground-truth entities planted in the document. */
  planted: number
  /** Planted entities the run recovered (sku match, amount within 1%). */
  recovered: number
  /** recovered / planted; 0 when nothing was planted. */
  recall: number
  /** Output items beyond the first per sku. */
  duplicates: number
  /** duplicates / output length; 0 when the output is empty. */
  duplicateRate: number
}

/** Amount tolerance for a match: absorbs formatting drift like "USD 1,840". */
const AMOUNT_TOLERANCE = 0.01

/**
 * Score an extraction against the planted ground truth.
 *
 * A planted entity is recovered when some output item has the same sku and an
 * amount within 1%. Noise transactions (skus never planted) count neither for
 * nor against recall; they do inflate the output, which the duplicate and
 * item counts expose.
 */
export function scoreExtraction(
  planted: PlantedTx[],
  output: ExtractionOutput[],
): Metrics {
  const plantedBySku = new Map<string, PlantedTx>()
  for (const tx of planted) {
    if (!plantedBySku.has(tx.sku)) plantedBySku.set(tx.sku, tx)
  }

  let recovered = 0
  for (const [, tx] of plantedBySku) {
    const match = output.some(
      (item) =>
        item.sku === tx.sku &&
        Math.abs(item.amount - tx.amount) <= tx.amount * AMOUNT_TOLERANCE,
    )
    if (match) recovered++
  }

  const seen = new Set<string>()
  let duplicates = 0
  for (const item of output) {
    if (seen.has(item.sku)) duplicates++
    else seen.add(item.sku)
  }

  return {
    planted: plantedBySku.size,
    recovered,
    recall: plantedBySku.size === 0 ? 0 : recovered / plantedBySku.size,
    duplicates,
    duplicateRate: output.length === 0 ? 0 : duplicates / output.length,
  }
}
