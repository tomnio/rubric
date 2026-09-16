/**
 * Package entry-point contract.
 *
 * The exports map promises both `import` and `require` for every entry. The
 * dist files are ESM (the package is `"type": "module"`), so `require()` works
 * through Node's require-of-ESM support (20.17+ behind a flag, 22.12+/23+
 * unflagged) — meaning a CJS consumer gets the same module instance semantics
 * as an ESM one. If a future edit removes the `require` condition, adds a
 * top-level await to the entry files, or splits CJS/ESM builds apart, these
 * tests catch it before the package ships.
 */
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

interface PkgJson {
  type: string
  exports: Record<string, Record<string, string>>
}

const pkg: PkgJson = JSON.parse(
  readFileSync(`${repoRoot}package.json`, "utf8"),
) as PkgJson

/** Read a built file as CJS would, through the exports map or straight from disk. */
function requireDist(specifier: string): Record<string, unknown> {
  // Run `pnpm build` first (CI does this before tests). Fail with a hint
  // instead of a bare MODULE_NOT_FOUND when the dist is missing.
  try {
    if (specifier === ".") {
      return require(`${repoRoot}dist/index.js`)
    }
    return require(`${repoRoot}dist/document/index.js`)
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    ) {
      throw new Error(
        "dist/ not found — run `pnpm build` before the test suite " +
          "(CI builds first for this reason)",
      )
    }
    throw error
  }
}

describe("package entry points", () => {
  it("declares both import and require for every export", () => {
    for (const [entry, conditions] of Object.entries(pkg.exports)) {
      expect(conditions["import"], `${entry} import condition`).toBeTruthy()
      expect(conditions["require"], `${entry} require condition`).toBeTruthy()
    }
  })

  it("builds without top-level await, so require(esm) can load the entries", () => {
    // require() of an ESM graph fails when any module in it has top-level
    // await. Loading the entries through createRequire is the same check a
    // CJS consumer's `require("@tomnio/rubric")` performs.
    const main = requireDist(".")
    expect(typeof (main as { wrap?: unknown }).wrap).toBe("function")

    const document = requireDist("./document")
    expect(
      typeof (document as { createDocument?: unknown }).createDocument,
    ).toBe("function")
  })

  it("is type: module, so the dist files are the ESM build", () => {
    // If the package ever stops being `"type": "module"`, the `require`
    // condition pointing at the same dist files would load them as CJS and
    // fail on `export` syntax. Pinned so that change is a conscious one.
    expect(pkg.type).toBe("module")
  })
})
