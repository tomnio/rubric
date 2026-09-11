import type { LLMClient, RequestKwargs } from "../types.ts"

/** Duck-typed Anthropic messages client. No hard dependency on the SDK. */
export type AnthropicMessagesClient = {
  messages: {
    create: (body: unknown) => Promise<unknown>
  }
}

export function isAnthropicMessagesClient(
  client: unknown,
): client is AnthropicMessagesClient {
  if (client === null || typeof client !== "object") {
    return false
  }
  const messages = (client as { messages?: unknown }).messages
  if (messages === null || typeof messages !== "object") {
    return false
  }
  return typeof (messages as { create?: unknown }).create === "function"
}

export function fromAnthropic(client: AnthropicMessagesClient): LLMClient {
  return {
    chatCompletionsCreate(kwargs: RequestKwargs) {
      return client.messages.create(kwargs)
    },
    async *chatCompletionsStream(kwargs: RequestKwargs) {
      const result = await Promise.resolve(
        client.messages.create({ ...kwargs, stream: true }),
      )
      if (
        result !== null &&
        typeof result === "object" &&
        Symbol.asyncIterator in result
      ) {
        yield* result as AsyncIterable<unknown>
        return
      }
      throw new Error("Anthropic stream did not return an async iterable")
    },
  }
}
