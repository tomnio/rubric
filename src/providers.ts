import type { Mode } from "./types.js"

/** OpenAI-compatible chat.completions gateways. Use with `new OpenAI({ baseURL })`. */
export type CompatibleProvider = {
  baseURL: string
  /** Forced tool_choice fails on some thinking models; then use MD_JSON. */
  mode: Mode
}

export const compatible = {
  deepseek: {
    baseURL: "https://api.deepseek.com",
    mode: "TOOLS",
  },
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    mode: "TOOLS",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    mode: "TOOLS",
  },
  together: {
    baseURL: "https://api.together.xyz/v1",
    mode: "TOOLS",
  },
  moonshot: {
    baseURL: "https://api.moonshot.cn/v1",
    mode: "TOOLS",
  },
} as const satisfies Record<string, CompatibleProvider>
