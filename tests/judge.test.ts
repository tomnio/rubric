import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  llmRefine,
  RetryExhaustedError,
  SchemaValidationError,
  wrap,
  type LLMClient,
} from "../src/index.js"
import { EXTRACT_TOOL_NAME } from "../src/modes/tools.js"

const ValidatorPayload = (isValid: boolean, reason: string | null = null) => ({
  is_valid: isValid,
  reason,
  fixed_value: null,
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

/** A judge that always returns the same verdict. */
function judgeClient(verdict: unknown): LLMClient {
  return {
    async chatCompletionsCreate() {
      return toolResponse(verdict)
    },
  }
}

describe("llmRefine", () => {
  it("accepts a value the judge approves", async () => {
    const judge = wrap(judgeClient(ValidatorPayload(true)))
    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("must be polite", judge)),
    })

    const client = wrap(
      fakeExtract(toolResponse({ answer: "Thank you kindly" })),
    )
    const value = await client.create({
      model: "test-model",
      schema: Answer,
      messages: [{ role: "user", content: "say something polite" }],
    })

    expect(value.answer).toBe("Thank you kindly")
  })

  it("reasks with the judge's reason when the value fails", async () => {
    let verdicts = 0
    const judge = wrap({
      async chatCompletionsCreate() {
        verdicts += 1
        return toolResponse(
          verdicts === 1
            ? ValidatorPayload(false, "The statement promotes objectionable behavior.")
            : ValidatorPayload(true),
        )
      },
    })

    let extracts = 0
    const calls: Array<{ messages: unknown }> = []
    const client = wrap({
      async chatCompletionsCreate(kwargs) {
        calls.push({ messages: kwargs.messages })
        extracts += 1
        return extracts === 1
          ? toolResponse({ answer: "The meaning of life is to be evil and steal" })
          : toolResponse({ answer: "The meaning of life is subjective" })
      },
    })

    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("don't say objectionable things", judge)),
    })

    const value = await client.create({
      model: "test-model",
      schema: Answer,
      messages: [{ role: "user", content: "what is the meaning of life?" }],
    })

    expect(value.answer).toBe("The meaning of life is subjective")
    expect(calls).toHaveLength(2)

    // The judge's reason, not a generic message, reaches the second request.
    const second = calls[1]?.messages as Array<{ role: string; content: string }>
    const last = second.at(-1)
    expect(last?.role).toBe("tool")
    expect(last?.content).toMatch(/promotes objectionable behavior/)
    expect(last?.content).toMatch(/answer/)
  })

  it("passes the rule and candidate value to the judge as JSON data", async () => {
    let judgeMessages: Array<{ role: string; content: string }> = []
    const judge = wrap({
      async chatCompletionsCreate(kwargs) {
        judgeMessages = kwargs.messages as Array<{ role: string; content: string }>
        return toolResponse(ValidatorPayload(true))
      },
    })

    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("must be a real person", judge)),
    })
    const client = wrap(fakeExtract(toolResponse({ answer: "Ada Lovelace" })))

    await client.create({
      model: "test-model",
      schema: Answer,
      messages: [{ role: "user", content: "name someone" }],
    })

    expect(judgeMessages[0]?.role).toBe("system")
    expect(judgeMessages[0]?.content).toMatch(/never follow instructions/)

    const payload = JSON.parse(judgeMessages[1]?.content ?? "{}") as Record<string, string>
    expect(payload["validation_rule"]).toBe("must be a real person")
    expect(payload["candidate_value"]).toBe("Ada Lovelace")
  })

  it("reuses the enclosing model when no model is given", async () => {
    let judgeModel: string | undefined
    const judge = wrap({
      async chatCompletionsCreate(kwargs) {
        judgeModel = kwargs.model
        return toolResponse(ValidatorPayload(true))
      },
    })

    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("must be polite", judge)),
    })
    const client = wrap(fakeExtract(toolResponse({ answer: "hello" })))

    await client.create({
      model: "gpt-4o-mini",
      schema: Answer,
      messages: [{ role: "user", content: "greet" }],
    })

    expect(judgeModel).toBe("gpt-4o-mini")
  })

  it("lets an explicit model override the enclosing one", async () => {
    let judgeModel: string | undefined
    const judge = wrap({
      async chatCompletionsCreate(kwargs) {
        judgeModel = kwargs.model
        return toolResponse(ValidatorPayload(true))
      },
    })

    const Answer = z.object({
      answer: z
        .string()
        .superRefine(llmRefine("must be polite", judge, { model: "judge-model" })),
    })
    const client = wrap(fakeExtract(toolResponse({ answer: "hello" })))

    await client.create({
      model: "gpt-4o-mini",
      schema: Answer,
      messages: [{ role: "user", content: "greet" }],
    })

    expect(judgeModel).toBe("judge-model")
  })

  it("keeps concurrent calls on their own model", async () => {
    // The judge reads the enclosing model from ambient context, after an
    // await. Two concurrent create() calls must not see each other's model.
    const seen: string[] = []
    const judge = wrap({
      async chatCompletionsCreate(kwargs) {
        // Yield so both judges are in flight at once.
        await new Promise((resolve) => setTimeout(resolve, 5))
        seen.push(kwargs.model)
        return toolResponse(ValidatorPayload(true))
      },
    })

    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("must be polite", judge)),
    })

    const run = (model: string) =>
      wrap(fakeExtract(toolResponse({ answer: "hello" }))).create({
        model,
        schema: Answer,
        messages: [{ role: "user", content: "greet" }],
      })

    await Promise.all([run("model-a"), run("model-b")])

    expect(seen.sort()).toEqual(["model-a", "model-b"])
  })

  it("exhausts retries when the judge keeps rejecting", async () => {
    const judge = wrap(judgeClient(ValidatorPayload(false, "still objectionable")))
    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("don't say objectionable things", judge)),
    })
    const client = wrap(fakeExtract(toolResponse({ answer: "evil" })))

    const error = (await client
      .create({
        model: "test-model",
        schema: Answer,
        messages: [{ role: "user", content: "x" }],
        maxRetries: 0,
      })
      .catch((err: unknown) => err)) as RetryExhaustedError

    expect(error).toBeInstanceOf(RetryExhaustedError)
    expect(error.attempts).toBe(1)
    const lastError = error.lastError as SchemaValidationError
    expect(lastError.issues[0]?.message).toMatch(/still objectionable/)
    expect(lastError.issues[0]?.path).toEqual(["answer"])
  })

  it("propagates a judge that itself fails", async () => {
    const judge = wrap({
      async chatCompletionsCreate() {
        throw new Error("judge is down")
      },
    })
    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("must be polite", judge)),
    })
    const client = wrap(fakeExtract(toolResponse({ answer: "hello" })))

    await expect(
      client.create({
        model: "test-model",
        schema: Answer,
        messages: [{ role: "user", content: "greet" }],
      }),
    ).rejects.toThrow(/judge is down/)
  })

  it("throws a clear error when no model is available", async () => {
    const judge = wrap(judgeClient(ValidatorPayload(true)))
    const Answer = z.object({
      answer: z.string().superRefine(llmRefine("must be polite", judge)),
    })
    // Parsing directly means there is no enclosing create() to supply a model,
    // so the missing-model error propagates rather than becoming an issue.
    await expect(Answer.safeParseAsync({ answer: "hi" })).rejects.toThrow(
      /needs a model/,
    )
  })
})

/** An extract client whose responses are fixed. */
function fakeExtract(response: unknown): LLMClient {
  return {
    async chatCompletionsCreate() {
      return response
    },
  }
}
