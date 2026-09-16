/**
 * Offline tests for the long-document example's generator and scorer.
 *
 * The generator must be deterministic (same seed, byte-identical text), must
 * place each "reworded" copy pair across a chunk boundary (the whole point of
 * the dedupeBy demo), and must never let noise skus collide with planted ones
 * (which would hand the scorer false credit). The scorer is pinned to exact
 * numbers on hand-built outputs.
 */
import { describe, expect, it } from "vitest"
import {
  generateLongDocument,
  scoreExtraction,
  type ExtractionOutput,
  type PlantedTx,
} from "../examples/lib/long-document.ts"

describe("generateLongDocument", () => {
  it("is deterministic for the same seed", () => {
    const a = generateLongDocument({ seed: 7, pages: 6, plantedCount: 10 })
    const b = generateLongDocument({ seed: 7, pages: 6, plantedCount: 10 })
    expect(a.text).toBe(b.text)
    expect(a.planted).toEqual(b.planted)
    expect(a.scalarConflicts).toEqual(b.scalarConflicts)
  })

  it("differs for different seeds", () => {
    const a = generateLongDocument({ seed: 7, pages: 6, plantedCount: 10 })
    const b = generateLongDocument({ seed: 8, pages: 6, plantedCount: 10 })
    expect(a.text).not.toBe(b.text)
  })

  it("reaches the requested scale by default", () => {
    const doc = generateLongDocument()
    // ~55 pages of ~2000 chars.
    expect(doc.charCount).toBeGreaterThanOrEqual(50 * 2000)
    expect(doc.planted).toHaveLength(40)
  })

  it("plants each sku at least once in the text", () => {
    const doc = generateLongDocument({ seed: 42, pages: 8, plantedCount: 12 })
    for (const tx of doc.planted) {
      expect(doc.text).toContain(tx.sku)
    }
  })

  it("never lets noise skus collide with planted skus", () => {
    const doc = generateLongDocument({ seed: 42, pages: 12, plantedCount: 20 })
    // Count how many times a planted sku appears; every planted "stable" sku
    // must appear exactly once (its one transaction line), and a noise
    // collision would show up as a second occurrence.
    const stable = doc.planted.filter((tx) => tx.kind === "stable")
    for (const tx of stable) {
      const matches = doc.text.match(new RegExp(`- ${tx.sku} \\|`, "g")) ?? []
      expect(matches).toHaveLength(1)
    }
  })

  it("places reworded copies on opposite sides of a chunk boundary", () => {
    const chunkSize = 4000
    const doc = generateLongDocument({
      seed: 42,
      pages: 12,
      plantedCount: 20,
      chunkSize,
    })
    const reworded = doc.planted.filter((tx) => tx.kind === "reworded")
    expect(reworded.length).toBeGreaterThan(0)

    for (const tx of reworded) {
      const first = doc.text.indexOf(tx.sku)
      // The second copy renders the sku with a space instead of a dash
      // ("SKU 1234" vs "SKU-1234").
      const spaced = tx.sku.replace(/^SKU-/, "SKU ")
      const second = doc.text.indexOf(spaced, first + 1)
      expect(second).toBeGreaterThan(first)

      // Both copies must straddle at least one boundary b = i * chunkSize:
      // the first window sees only the "first" copy, the next only the
      // "second", so reuniting them takes a cross-chunk entity-key merge.
      const boundaries: number[] = []
      for (let b = chunkSize; b < doc.charCount; b += chunkSize) {
        if (b > first && b < second) boundaries.push(b)
      }
      expect(boundaries.length).toBeGreaterThanOrEqual(1)
    }
  })

  it("places a scalar conflict pair in the document", () => {
    const doc = generateLongDocument({ seed: 42, pages: 8, plantedCount: 10 })
    expect(doc.scalarConflicts).toHaveLength(1)
    const [a, b] = doc.scalarConflicts[0]!.values
    expect(b! - a!).toBe(500_000)
    // Both figures must appear in the text.
    expect(doc.text).toContain("$" + a!.toLocaleString("en-US"))
  })
})

describe("scoreExtraction", () => {
  const planted: PlantedTx[] = [
    { sku: "SKU-1001", description: "bracket", amount: 100, region: "NA", kind: "stable" },
    { sku: "SKU-1002", description: "valve", amount: 200, region: "EMEA", kind: "stable" },
    { sku: "SKU-1003", description: "gasket", amount: 300, region: "APAC", kind: "reworded" },
  ]

  const item = (sku: string, amount: number): ExtractionOutput => ({ sku, amount })

  it("scores a perfect run", () => {
    const m = scoreExtraction(planted, [
      item("SKU-1001", 100),
      item("SKU-1002", 200),
      item("SKU-1003", 300),
    ])
    expect(m.planted).toBe(3)
    expect(m.recovered).toBe(3)
    expect(m.recall).toBe(1)
    expect(m.duplicates).toBe(0)
    expect(m.duplicateRate).toBe(0)
  })

  it("tolerates amounts within 1%", () => {
    const m = scoreExtraction(planted, [item("SKU-1001", 100.9)])
    expect(m.recovered).toBe(1)
  })

  it("rejects amounts off by more than 1%", () => {
    const m = scoreExtraction(planted, [item("SKU-1001", 102)])
    expect(m.recovered).toBe(0)
    expect(m.recall).toBe(0)
  })

  it("counts duplicates beyond the first per sku", () => {
    const m = scoreExtraction(planted, [
      item("SKU-1001", 100),
      item("SKU-1001", 100), // duplicate
      item("SKU-1001", 100), // duplicate again
      item("SKU-1002", 200),
    ])
    expect(m.recovered).toBe(2)
    expect(m.duplicates).toBe(2)
    expect(m.duplicateRate).toBeCloseTo(2 / 4)
  })

  it("ignores noise skus for recall", () => {
    const m = scoreExtraction(planted, [item("SKU-9999", 100)])
    expect(m.recovered).toBe(0)
    expect(m.recall).toBe(0)
    expect(m.duplicates).toBe(0)
  })

  it("reports zero recall for empty output", () => {
    const m = scoreExtraction(planted, [])
    expect(m.recall).toBe(0)
    expect(m.duplicateRate).toBe(0)
  })
})
