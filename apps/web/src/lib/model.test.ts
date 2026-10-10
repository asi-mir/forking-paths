import { describe, expect, it } from "vitest";
import {
  getModel,
  ModelConfigError,
  providerOptionsFor,
  resolveModelConfig,
  resolveProvider,
} from "./model";

const KEY = { GOOGLE_GENERATIVE_AI_API_KEY: "test-key-not-real" };

describe("resolveProvider", () => {
  it("auto picks Google when the key is set, Ollama otherwise", () => {
    expect(resolveProvider("writer", { ...KEY })).toBe("google");
    expect(resolveProvider("writer", {})).toBe("ollama");
    expect(resolveProvider("writer", { GEMMA_PROVIDER: "auto", GOOGLE_GENERATIVE_AI_API_KEY: " " })).toBe("ollama");
  });

  it("follows GEMMA_PROVIDER, and a per-role override wins", () => {
    const env = { ...KEY, GEMMA_PROVIDER: "google", GEMMA_READER_PROVIDER: "ollama" };
    expect(resolveProvider("writer", env)).toBe("google");
    expect(resolveProvider("narrator", env)).toBe("google");
    expect(resolveProvider("reader", env)).toBe("ollama");
    expect(resolveProvider("writer", { GEMMA_PROVIDER: "OLLAMA", ...KEY })).toBe("ollama");
  });

  it("rejects an unknown provider name", () => {
    expect(() => resolveProvider("writer", { GEMMA_PROVIDER: "openai" })).toThrow(ModelConfigError);
    expect(() => resolveProvider("reader", { GEMMA_READER_PROVIDER: "x" })).toThrow(/GEMMA_READER_PROVIDER/);
  });
});

describe("resolveModelConfig", () => {
  it("uses Gemma 4 model IDs and role timeouts on Google", () => {
    const writer = resolveModelConfig("writer", { ...KEY });
    expect(writer).toMatchObject({ provider: "google", modelId: "gemma-4-31b-it", thinking: "high", timeoutMs: 90_000 });
    const reader = resolveModelConfig("reader", { ...KEY });
    expect(reader).toMatchObject({ modelId: "gemma-4-26b-a4b-it", thinking: "minimal", timeoutMs: 30_000 });
  });

  it("reads model IDs from env; the narrator falls back to the reader model", () => {
    const env = { ...KEY, GEMMA_WRITER_MODEL: "gemma-4-26b-a4b-it", GEMMA_READER_MODEL: "gemma-4-31b-it" };
    expect(resolveModelConfig("writer", env).modelId).toBe("gemma-4-26b-a4b-it");
    expect(resolveModelConfig("narrator", env).modelId).toBe("gemma-4-31b-it");
  });

  it("uses OLLAMA_MODEL and OLLAMA_BASE_URL on Ollama, with longer timeouts", () => {
    const config = resolveModelConfig("writer", {
      GEMMA_PROVIDER: "ollama",
      OLLAMA_MODEL: "gemma4:12b",
      OLLAMA_BASE_URL: "http://example.test:11434/v1/",
      GEMMA_WRITER_MODEL: "gemma-4-31b-it",
    });
    expect(config).toMatchObject({
      provider: "ollama",
      modelId: "gemma4:12b",
      baseURL: "http://example.test:11434/v1",
      timeoutMs: 300_000,
    });
    expect(resolveModelConfig("reader", {}).timeoutMs).toBe(120_000);
    expect(resolveModelConfig("reader", {}).modelId).toBe("gemma4:e4b");
  });

  it("refuses closed models and Ollama cloud models", () => {
    expect(() => resolveModelConfig("writer", { ...KEY, GEMMA_WRITER_MODEL: "gemini-3.5-flash" })).toThrow(
      /Only Gemma/,
    );
    expect(() => resolveModelConfig("reader", { OLLAMA_MODEL: "kimi-k2.5:cloud" })).toThrow(/cloud/);
    expect(() => resolveModelConfig("reader", { OLLAMA_MODEL: "gpt-oss:120b-cloud" })).toThrow(/cloud/);
  });

  it("reads GEMMA_<ROLE>_THINKING and its aliases", () => {
    expect(resolveModelConfig("writer", { GEMMA_WRITER_THINKING: "off" }).thinking).toBe("minimal");
    expect(resolveModelConfig("reader", { GEMMA_READER_THINKING: "HIGH" }).thinking).toBe("high");
    expect(() => resolveModelConfig("writer", { GEMMA_WRITER_THINKING: "low" })).toThrow(/minimal" or "high/);
  });
});

describe("providerOptionsFor", () => {
  it("always sends a Google thinking level (Gemma thinks when none is sent)", () => {
    expect(providerOptionsFor(resolveModelConfig("writer", { ...KEY }))).toEqual({
      google: { thinkingConfig: { thinkingLevel: "high" } },
    });
    expect(providerOptionsFor(resolveModelConfig("reader", { ...KEY }))).toEqual({
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
  });

  it("maps thinking to Ollama reasoning_effort", () => {
    expect(providerOptionsFor(resolveModelConfig("reader", {}))).toEqual({ ollama: { reasoningEffort: "none" } });
    expect(providerOptionsFor(resolveModelConfig("writer", {}))).toEqual({ ollama: { reasoningEffort: "high" } });
  });
});

describe("getModel", () => {
  it("builds an AI SDK v4 model for each provider without a network call", () => {
    const google = getModel("writer", { ...KEY });
    expect(google.specificationVersion).toBe("v4");
    expect(google.modelId).toBe("gemma-4-31b-it");
    const ollama = getModel("reader", { GEMMA_PROVIDER: "ollama" });
    expect(ollama.modelId).toBe("gemma4:e4b");
    expect(ollama.provider).toContain("ollama");
  });

  it("fails clearly when Google is chosen without a key", () => {
    expect(() => getModel("writer", { GEMMA_PROVIDER: "google" })).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY is not set/);
  });
});
