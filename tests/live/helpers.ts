/**
 * Shared setup for the live suites in this directory.
 *
 * Every other test in this repo runs against a fake client, so it never
 * touches the network. The suites here do the opposite: they make a real SDK
 * round trip to prove the adapters, the reask loop, the citation guardrail and
 * the document pipeline work end to end against a live provider.
 *
 * They are opt-in twice over, so neither `pnpm test` nor CI ever reaches the
 * network by accident:
 *
 *   1. `RUBRIC_LIVE=1` must be set (the `test:live` script sets it), and
 *   2. the provider's API key must be present.
 *
 * Without both, every suite here skips. Credentials are read from the process
 * environment; a `.env` in the package root is loaded first when it exists (it
 * is gitignored), so dropping a key there is enough:
 *
 *   pnpm test:live
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { wrap, type Mode, type RubricClient } from "../../src/index.js"

// Node 20.12+ can read a dotenv file without a dependency. It never overwrites
// a variable the shell already set, so `OPENAI_API_KEY=... pnpm test:live`
// still wins over the file.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url))
if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile)
}

/** The opt-in switch: without it no live test runs, keys or not. */
export const LIVE = process.env["RUBRIC_LIVE"] === "1"

function read(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === "" ? undefined : value
}

export const OPENAI_KEY = read("OPENAI_API_KEY")
/** Set to point the OpenAI suite at a compatible gateway instead of OpenAI. */
export const OPENAI_BASE_URL = read("OPENAI_BASE_URL")
export const OPENAI_MODEL = read("OPENAI_MODEL") ?? "gpt-4o-mini"
/** Request encoding: TOOLS | JSON_SCHEMA | MD_JSON. A thinking model needs MD_JSON. */
export const OPENAI_MODE = (read("OPENAI_MODE") ?? "TOOLS") as Mode

export const ANTHROPIC_KEY = read("ANTHROPIC_API_KEY")
export const ANTHROPIC_MODEL = read("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6"

export const hasOpenAI = LIVE && OPENAI_KEY !== undefined
export const hasAnthropic = LIVE && ANTHROPIC_KEY !== undefined

/** A raw OpenAI-compatible client, for createDocument() (which resolves it). */
export function openaiSdk(): OpenAI {
  const apiKey = OPENAI_KEY ?? ""
  return OPENAI_BASE_URL
    ? new OpenAI({ apiKey, baseURL: OPENAI_BASE_URL })
    : new OpenAI({ apiKey })
}

/** The same client wrapped, for create() / createPartial() / createIterable(). */
export function openaiWrapped(): RubricClient {
  return wrap(openaiSdk(), { mode: OPENAI_MODE })
}

export function anthropicSdk(): Anthropic {
  return new Anthropic({ apiKey: ANTHROPIC_KEY ?? "" })
}

export function anthropicWrapped(): RubricClient {
  return wrap(anthropicSdk())
}

/** True when the optional WASM chunker is installed, so createDocument() can run. */
export const hasChonkie = await import("@chonkiejs/core")
  .then(() => true)
  .catch(() => false)
