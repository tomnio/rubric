import type { CallOptions, LLMClient, RequestKwargs } from "../types.js"

/**
 * Duck-typed Anthropic messages client. No hard dependency on the SDK.
 *
 * Method syntax, not a function-typed property: see `OpenAIChatClient` for why
 * the bivariant check is what lets `wrap(new Anthropic())` typecheck.
 */
export type AnthropicMessagesClient = {
  messages: {
    create(body: unknown, options?: CallOptions): Promise<unknown>
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
    chatCompletionsCreate(kwargs: RequestKwargs, options?: CallOptions) {
      return options?.signal
        ? client.messages.create(kwargs, { signal: options.signal })
        : client.messages.create(kwargs)
    },
    async *chatCompletionsStream(kwargs: RequestKwargs, options?: CallOptions) {
      const body = { ...kwargs, stream: true }
      const result = await Promise.resolve(
        options?.signal
          ? client.messages.create(body, { signal: options.signal })
          : client.messages.create(body),
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
