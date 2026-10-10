import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractJson, generateJson, ModelCallError, ModelOutputError } from "./json";
import { solidPng } from "./solid-png";

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

function answer(text: string, tokens = { input: 10, output: 5 }): GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: tokens.input, noCache: tokens.input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: tokens.output, text: tokens.output, reasoning: 2 },
    },
    warnings: [],
  };
}

function httpError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
    isRetryable: true,
  });
}

/** A mock model that returns (or throws) the given steps in order. */
function scripted(steps: Array<GenerateResult | Error>) {
  let i = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-gemma",
    doGenerate: async () => {
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
  });
}

const OLLAMA_ENV = { GEMMA_PROVIDER: "ollama" };
const schema = z.object({ title: z.string(), stops: z.number().int().min(1) });
const noSleep = async () => {};

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips code fences and leading text", () => {
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2]}\n```\nEnjoy!')).toEqual({ a: [1, 2] });
    expect(extractJson('Sure! {"a": "x"} Hope that helps.')).toEqual({ a: "x" });
  });

  it("ignores braces inside strings and skips invalid candidates", () => {
    expect(extractJson('note {not json} then {"text": "a } b { c", "n": 2}')).toEqual({ text: "a } b { c", n: 2 });
    expect(extractJson('{"q": "say \\"hi\\" }"}')).toEqual({ q: 'say "hi" }' });
  });

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(SyntaxError);
  });
});

describe("generateJson", () => {
  it("returns validated data and usage meta", async () => {
    const model = scripted([answer('{"title":"The Fountain","stops":4}')]);
    const { data, meta } = await generateJson("writer", schema, "write", undefined, { env: OLLAMA_ENV, model });
    expect(data).toEqual({ title: "The Fountain", stops: 4 });
    expect(meta).toMatchObject({
      role: "writer",
      provider: "ollama",
      model: "gemma4:e4b",
      thinking: "high",
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      requests: 1,
      repaired: false,
    });
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends the JSON schema as the response format, plus thinking options", async () => {
    const model = scripted([answer('{"title":"x","stops":1}')]);
    await generateJson("writer", schema, "write", undefined, { env: OLLAMA_ENV, model });
    const call = model.doGenerateCalls[0];
    expect(call.responseFormat).toMatchObject({ type: "json" });
    expect((call.responseFormat as { schema?: unknown }).schema).toBeTruthy();
    expect(call.providerOptions).toEqual({ ollama: { reasoningEffort: "high" } });
  });

  it("accepts an answer wrapped in a code fence", async () => {
    const model = scripted([answer('```json\n{"title":"x","stops":2}\n```')]);
    const { data, meta } = await generateJson("writer", schema, "write", undefined, { env: OLLAMA_ENV, model });
    expect(data.stops).toBe(2);
    expect(meta.repaired).toBe(false);
  });

  it("repairs once, showing the model its validation error", async () => {
    const model = scripted([answer('{"title":"x","stops":0}'), answer('{"title":"x","stops":3}')]);
    const { data, meta } = await generateJson("writer", schema, "write", undefined, { env: OLLAMA_ENV, model });
    expect(data.stops).toBe(3);
    expect(meta).toMatchObject({ repaired: true, requests: 2, inputTokens: 20, outputTokens: 10 });
    const retry = JSON.stringify(model.doGenerateCalls[1].prompt);
    expect(retry).toContain("stops");
    expect(retry).toContain("corrected JSON");
  });

  it("throws ModelOutputError after a failed repair", async () => {
    const model = scripted([answer("not json"), answer('{"title":1}')]);
    const error = await generateJson("writer", schema, "write", undefined, { env: OLLAMA_ENV, model }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ModelOutputError);
    expect((error as ModelOutputError).meta.requests).toBe(2);
    expect((error as ModelOutputError).lastText).toBe('{"title":1}');
  });

  it("backs off and retries on 429 and 503", async () => {
    const waits: number[] = [];
    const model = scripted([httpError(429), httpError(503), answer('{"title":"x","stops":1}')]);
    const { meta } = await generateJson("writer", schema, "write", undefined, {
      env: OLLAMA_ENV,
      model,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(meta.requests).toBe(3);
    expect(waits).toEqual([2_000, 4_000]);
  });

  it("gives up after three backoff retries", async () => {
    const model = scripted([httpError(503)]);
    const error = await generateJson("writer", schema, "write", undefined, {
      env: OLLAMA_ENV,
      model,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).statusCode).toBe(503);
    expect((error as ModelCallError).meta.requests).toBe(4);
  });

  it("does not retry a 400", async () => {
    const model = scripted([httpError(400), answer('{"title":"x","stops":1}')]);
    const error = await generateJson("writer", schema, "write", undefined, {
      env: OLLAMA_ENV,
      model,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).meta.requests).toBe(1);
  });

  it("times out a slow call", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ({ abortSignal }) =>
        new Promise((_, reject) => {
          abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
        }),
    });
    const error = await generateJson("reader", schema, "read", undefined, {
      env: OLLAMA_ENV,
      model,
      timeoutMs: 20,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as Error).message).toContain("timed out after 20 ms");
  });

  it("sends images as file parts with their media type", async () => {
    const png = solidPng(4, 4, [255, 0, 0]);
    const model = scripted([answer('{"title":"red","stops":1}')]);
    await generateJson("reader", schema, "what colour?", [{ data: png, mediaType: "image/png" }], {
      env: OLLAMA_ENV,
      model,
    });
    const user = model.doGenerateCalls[0].prompt.find((m) => m.role === "user");
    const parts = user?.content as Array<{ type: string; mediaType?: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "file"]);
    expect(parts[1].mediaType).toBe("image/png");
  });
});
