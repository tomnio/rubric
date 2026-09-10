import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  imageUrl,
  wrap,
  type LLMClient,
  type RequestKwargs,
} from "../src/index.ts"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.ts"

const User = z.object({
  name: z.string(),
  age: z.number().int(),
})

function toolResponse(payload: unknown): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: EXTRACT_TOOL_NAME,
                arguments: JSON.stringify(payload),
              },
            },
          ],
        },
      },
    ],
  }
}

describe("image messages", () => {
  it("forwards image_url parts on the user message", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap({
      async chatCompletionsCreate(kwargs) {
        capture.push(kwargs)
        return toolResponse({ name: "John", age: 25 })
      },
    } satisfies LLMClient)

    const image = imageUrl("https://example.com/person.jpg", "low")
    const user = await client.create({
      model: "test-model",
      schema: User,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the person in this image." },
            image,
          ],
        },
      ],
    })

    expect(user).toEqual({ name: "John", age: 25 })
    expect(capture[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "Extract the person in this image." },
      {
        type: "image_url",
        image_url: { url: "https://example.com/person.jpg", detail: "low" },
      },
    ])
  })

  it("keeps image parts when MD_JSON prepends a system instruction", async () => {
    const capture: RequestKwargs[] = []
    const client = wrap(
      {
        async chatCompletionsCreate(kwargs) {
          capture.push(kwargs)
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({ name: "John", age: 25 }),
                },
              },
            ],
          }
        },
      } satisfies LLMClient,
      { mode: "MD_JSON" },
    )

    const image = imageUrl("data:image/png;base64,aaa")
    await client.create({
      model: "test-model",
      schema: User,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Who is this?" }, image],
        },
      ],
    })

    const userMessage = capture[0]?.messages.find((message) => message.role === "user")
    expect(userMessage?.content).toEqual([
      { type: "text", text: "Who is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
    ])
  })
})
