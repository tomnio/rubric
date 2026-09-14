import type { CallOptions, LLMClient, RequestKwargs } from "../types.js"

/** Duck-typed Google GenAI client (`models.generateContent`). */
export type GeminiModelsClient = {
  models: {
    generateContent: (body: unknown, options?: CallOptions) => Promise<unknown>
    generateContentStream?: (
      body: unknown,
      options?: CallOptions,
    ) => AsyncIterable<unknown>
  }
}

export function isGeminiModelsClient(client: unknown): client is GeminiModelsClient {
  if (client === null || typeof client !== "object") {
    return false
  }
  const models = (client as { models?: unknown }).models
  if (models === null || typeof models !== "object") {
    return false
  }
  return typeof (models as { generateContent?: unknown }).generateContent === "function"
}

function geminiBody(kwargs: RequestKwargs, options?: CallOptions): unknown {
  const config = {
    ...(typeof kwargs.config === "object" && kwargs.config !== null
      ? (kwargs.config as Record<string, unknown>)
      : {}),
  }
  if (kwargs.temperature !== undefined) {
    config["temperature"] = kwargs.temperature
  }
  if (kwargs.max_tokens !== undefined) {
    config["maxOutputTokens"] = kwargs.max_tokens
  }
  if (kwargs.top_p !== undefined) {
    config["topP"] = kwargs.top_p
  }
  if (options?.signal) {
    config["abortSignal"] = options.signal
  }
  const body: Record<string, unknown> = {
    model: kwargs.model,
    contents: kwargs.contents,
    config,
  }
  if (kwargs.systemInstruction !== undefined) {
    body["systemInstruction"] = kwargs.systemInstruction
  }
  return body
}

export function fromGemini(client: GeminiModelsClient): LLMClient {
  return {
    chatCompletionsCreate(kwargs: RequestKwargs, options?: CallOptions) {
      return client.models.generateContent(geminiBody(kwargs, options))
    },
    async *chatCompletionsStream(kwargs: RequestKwargs, options?: CallOptions) {
      const stream = client.models.generateContentStream
      if (!stream) {
        throw new Error("Gemini client does not implement generateContentStream")
      }
      yield* stream.call(client.models, geminiBody(kwargs, options))
    },
  }
}
