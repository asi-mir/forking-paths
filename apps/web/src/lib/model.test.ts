import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getModel,
  ModelConfigError,
  ollamaHeaders,
  ollamaRoot,
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

describe("ollamaHeaders (OLLAMA_AUTH_HEADER)", () => {
  const SECRET = "dGVzdDpub3QtcmVhbA=="; // base64 of "test:not-real"

  it("is empty when unset", () => {
    expect(ollamaHeaders({})).toEqual({});
    expect(ollamaHeaders({ OLLAMA_AUTH_HEADER: "  " })).toEqual({});
  });

  it("reads an Authorization value, a named header, or several", () => {
    expect(ollamaHeaders({ OLLAMA_AUTH_HEADER: `Basic ${SECRET}` })).toEqual({ Authorization: `Basic ${SECRET}` });
    expect(ollamaHeaders({ OLLAMA_AUTH_HEADER: "Bearer abc.def" })).toEqual({ Authorization: "Bearer abc.def" });
    expect(ollamaHeaders({ OLLAMA_AUTH_HEADER: "X-Tunnel-Key: k1" })).toEqual({ "X-Tunnel-Key": "k1" });
    expect(ollamaHeaders({ OLLAMA_AUTH_HEADER: "CF-Access-Client-Id: id.access; CF-Access-Client-Secret: s3cr3t" })).toEqual({
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "s3cr3t",
    });
  });

  it("refuses a malformed value without repeating it", () => {
    for (const bad of ["playtest:hunter2x", "justatoken", "Basic a\r\nX-Evil: 1", "Bad Name: v"]) {
      let message = "";
      try {
        ollamaHeaders({ OLLAMA_AUTH_HEADER: bad });
      } catch (error) {
        expect(error).toBeInstanceOf(ModelConfigError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/OLLAMA_AUTH_HEADER must be/);
      expect(message).not.toContain(bad);
    }
  });
});

describe("Ollama through a tunnel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks the config as protected, and keeps the header out of it", () => {
    const config = resolveModelConfig("reader", {
      GEMMA_READER_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "https://gemma.tunnel.test/v1",
      OLLAMA_AUTH_HEADER: "Basic c2VjcmV0",
    });
    expect(config).toMatchObject({ provider: "ollama", baseURL: "https://gemma.tunnel.test/v1", auth: true });
    expect(JSON.stringify(config)).not.toContain("c2VjcmV0");
    expect(ollamaRoot(config)).toBe("https://gemma.tunnel.test");
    expect(resolveModelConfig("reader", {}).auth).toBe(false);
  });

  it("refuses credentials in the URL, and the header over plain http to another host", () => {
    expect(() => resolveModelConfig("reader", { OLLAMA_BASE_URL: "https://u:p@gemma.tunnel.test/v1" })).toThrow(
      /must not contain a user name or password/,
    );
    expect(() =>
      resolveModelConfig("reader", { OLLAMA_BASE_URL: "http://gemma.tunnel.test/v1", OLLAMA_AUTH_HEADER: "Basic c2VjcmV0" }),
    ).toThrow(/only over https/);
    expect(() => resolveModelConfig("reader", { OLLAMA_BASE_URL: "not a url" })).toThrow(/not a valid URL/);
    expect(() => resolveModelConfig("reader", { OLLAMA_BASE_URL: "ftp://x/v1" })).toThrow(/http:\/\/ or https:\/\//);
    // A local proxy that checks the header is fine over http.
    expect(
      resolveModelConfig("reader", { OLLAMA_BASE_URL: "http://127.0.0.1:8080/v1", OLLAMA_AUTH_HEADER: "Basic c2VjcmV0" }).auth,
    ).toBe(true);
  });

  it("sends the header on every model request (stubbed fetch, no network)", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "gemma4:e4b",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const env = {
      GEMMA_READER_PROVIDER: "ollama",
      OLLAMA_BASE_URL: "https://gemma.tunnel.test/v1",
      OLLAMA_AUTH_HEADER: "Basic c2VjcmV0",
    };
    const result = await generateText({ model: getModel("reader", env), prompt: "hi", maxRetries: 0 });
    expect(result.text).toBe("ok");
    expect(seen).toEqual([{ url: "https://gemma.tunnel.test/v1/chat/completions", auth: "Basic c2VjcmV0" }]);

    // Without the variable, no Authorization header is sent.
    await generateText({ model: getModel("reader", { GEMMA_READER_PROVIDER: "ollama" }), prompt: "hi", maxRetries: 0 });
    expect(seen[1]).toEqual({ url: "http://127.0.0.1:11434/v1/chat/completions", auth: null });
  });
});
