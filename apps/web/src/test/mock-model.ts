import { MockLanguageModelV4 } from "ai/test";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

/** A model answer with the given text, for MockLanguageModelV4. */
export function textAnswer(text: string): GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    },
    warnings: [],
  };
}

/** A mock model that returns (or throws) the given steps in order; the last one repeats. */
export function scriptedModel(steps: Array<GenerateResult | Error | string>): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-gemma",
    doGenerate: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return typeof step === "string" ? textAnswer(step) : step;
    },
  });
}

/** The text parts of the first user message of a recorded call. */
export function userText(model: MockLanguageModelV4, call = 0): string {
  const user = model.doGenerateCalls[call].prompt.find((m) => m.role === "user");
  const content = user?.content as Array<{ type: string; text?: string }>;
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}
