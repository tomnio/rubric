import type { CallOptions, LLMClient, RequestKwargs } from "../types.js"

/**
 * Duck-typed OpenAI chat client. Avoids a hard runtime dependency on `openai`.
 *
 * `create` is written in method syntax on purpose. A property typed as a
 * function checks its parameter contravariantly, and the real SDK's `create`
 * takes a specific request type, so `wrap(new OpenAI())` would not typecheck.
 * Method syntax makes the check bivariant, which is exactly what duck typing
 * wants: any client with a compatible `create` is accepted.
 */
export type OpenAIChatClient = {
  chat: {
    completions: {
      create(body: unknown, options?: CallOptions): Promise<unknown>
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

function createOptions(options?: CallOptions): CallOptions | undefined {
  if (options?.signal) {
    return { signal: options.signal }
  }
  return undefined
}

export function fromOpenAI(client: OpenAIChatClient): LLMClient {
  return {
    chatCompletionsCreate(kwargs: RequestKwargs, options?: CallOptions) {
      const opts = createOptions(options)
      return opts
        ? client.chat.completions.create(kwargs, opts)
        : client.chat.completions.create(kwargs)
    },
    async *chatCompletionsStream(kwargs: RequestKwargs, options?: CallOptions) {
      const body = {
        ...kwargs,
        stream: true,
        stream_options: kwargs.stream_options ?? { include_usage: true },
      }
      const opts = createOptions(options)
      const result = await Promise.resolve(
        opts
          ? client.chat.completions.create(body, opts)
          : client.chat.completions.create(body),
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
