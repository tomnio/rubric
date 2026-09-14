import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  compatible,
  wrap,
  type RequestKwargs,
} from "../src/index.js"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

describe("compatible providers", () => {
  it("exposes OpenAI-compatible baseURLs", () => {
    expect(compatible.deepseek.baseURL).toBe("https://api.deepseek.com")
    expect(compatible.groq.baseURL).toContain("/openai/v1")
    expect(compatible.openrouter.baseURL).toContain("openrouter")
    expect(compatible.together.mode).toBe("TOOLS")
    expect(compatible.moonshot.baseURL).toContain("moonshot")
  })
})

describe("GEMINI_JSON", () => {
  it("extracts from generateContent text and sends responseJsonSchema", async () => {
    const generateContent = vi.fn(async (body: unknown) => ({
      text: JSON.stringify({ name: "John", age: 25 }),
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
    }))
    const onUsage = vi.fn()
    const client = wrap(
      { models: { generateContent } },
      { hooks: { onUsage } },
    )
    const user = await client.create({
      model: "gemini-2.5-flash",
      schema: User,
      messages: [
        { role: "system", content: "Extract people." },
        { role: "user", content: "John is 25 years old" },
      ],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    const body = generateContent.mock.calls[0]?.[0] as {
      contents: unknown
      config: { responseMimeType: string; responseJsonSchema: unknown }
      systemInstruction: unknown
    }
    expect(body.config.responseMimeType).toBe("application/json")
    expect(body.config.responseJsonSchema).toMatchObject({ type: "object" })
    expect(body.systemInstruction).toEqual({
      parts: [{ text: "Extract people." }],
    })
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "John is 25 years old" }] },
    ])
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      inputTokens: 11,
      outputTokens: 4,
    })
  })

  it("reasks with model then user contents", async () => {
    const generateContent = vi.fn(async (body: unknown) => {
      const contents = (body as RequestKwargs).contents as unknown[]
      if (contents.length === 1) {
        return { text: JSON.stringify({ name: "John", age: "x" }) }
      }
      return { text: JSON.stringify({ name: "John", age: 25 }) }
    })
    const client = wrap({ models: { generateContent } })
    const user = await client.create({
      model: "gemini-2.5-flash",
      schema: User,
      messages: [{ role: "user", content: "John is 25 years old" }],
    })
    expect(user).toEqual({ name: "John", age: 25 })
    expect(generateContent).toHaveBeenCalledTimes(2)
    const second = generateContent.mock.calls[1]?.[0] as { contents: unknown[] }
    expect(second.contents).toHaveLength(3)
    expect(second.contents[1]).toEqual({
      role: "model",
      parts: [{ text: JSON.stringify({ name: "John", age: "x" }) }],
    })
    expect(second.contents[2]).toMatchObject({ role: "user" })
  })

  it("parses candidates[].content.parts text", async () => {
    const client = wrap({
      models: {
        async generateContent() {
          return {
            candidates: [
              {
                content: {
                  parts: [{ text: '{"name":"Jane","age":30}' }],
                },
              },
            ],
          }
        },
      },
    })
    const user = await client.create({
      model: "gemini-2.5-flash",
      schema: User,
      messages: [{ role: "user", content: "Jane is 30" }],
    })
    expect(user).toEqual({ name: "Jane", age: 30 })
  })
})
