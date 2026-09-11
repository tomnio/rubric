import type { LLMClient, RequestKwargs } from "../types.js"

/** Duck-typed OpenAI chat client. Avoids a hard runtime dependency on `openai`. */
export type OpenAIChatClient = {
  chat: {
    completions: {
      create: (body: unknown) => Promise<unknown>
    }
  }
}

export function isLLMClient(client: unknown): client is LLMClient {
  return (
    typeof client === "object" &&
    client !== null &&
    "chatCompletionsCreate" in client &&
    typeof (client as LLMClient).chatCompletionsCreate === "function"
  )
}

export function isOpenAIChatClient(client: unknown): client is OpenAIChatClient {
  if (client === null || typeof client !== "object") {
    return false
  }
  const chat = (client as { chat?: unknown }).chat
  if (chat === null || typeof chat !== "object") {
    return false
  }
  const completions = (chat as { completions?: unknown }).completions
  if (completions === null || typeof completions !== "object") {
    return false
  }
  return typeof (completions as { create?: unknown }).create === "function"
}

export function fromOpenAI(client: OpenAIChatClient): LLMClient {
  return {
    chatCompletionsCreate(kwargs: RequestKwargs) {
      return client.chat.completions.create(kwargs)
    },
    async *chatCompletionsStream(kwargs: RequestKwargs) {
      const result = await Promise.resolve(
        client.chat.completions.create({ ...kwargs, stream: true }),
      )
      if (
        result !== null &&
        typeof result === "object" &&
        Symbol.asyncIterator in result
      ) {
        yield* result as AsyncIterable<unknown>
        return
      }
      throw new Error("OpenAI stream did not return an async iterable")
    },
  }
}
