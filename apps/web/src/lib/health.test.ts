import { beforeEach, describe, expect, it, vi } from "vitest";
import { DB_PING_CACHE_MS, DB_PING_TIMEOUT_MS, healthReport, resetHealthCache } from "./health";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;
const GOOGLE_KEY = "test-google-key-abcdef123456";
const URI = "mongodb://db.example.net:27017/?appName=health-test";

beforeEach(() => resetHealthCache());

describe("healthReport", () => {
  it("runs with no settings: Ollama for every role, memory store, 200", async () => {
    const { status, body } = await healthReport({ env: env({}) });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.database).toEqual({ kind: "memory", ok: true });
    expect(body.models.writer).toEqual({ ok: true, provider: "ollama", model: "ollama/gemma4:e4b" });
    expect(body.services).toEqual({ google: false, serpapi: false, voice: { configured: false, live: false }, sentry: false });
    expect(body.caps).toEqual({ quests: 3, serpapi: 40, "tts-chars": 4000 });
    expect(body.commit).toBeNull();
  });

  it("reports Google Gemma per role and the caps from env, and never a secret value", async () => {
    const ping = vi.fn(async () => {});
    const { status, body } = await healthReport({
      env: env({
        GEMMA_PROVIDER: "google",
        GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE_KEY,
        SERPAPI_API_KEY: "serp-secret-123",
        ELEVENLABS_API_KEY: "el-secret-456",
        ELEVENLABS_VOICE_ID: "voice123",
        ELEVENLABS_LIVE: "1",
        SENTRY_DSN: "https://abc@o1.ingest.sentry.io/2",
        MONGODB_URI: URI,
        BUDGET_QUESTS_PER_DAY: "5",
        RENDER_GIT_COMMIT: "0123456789abcdef",
      }),
      ping,
    });
    expect(status).toBe(200);
    expect(body.models.writer).toEqual({ ok: true, provider: "google", model: "google/gemma-4-31b-it" });
    expect(body.models.reader).toEqual({ ok: true, provider: "google", model: "google/gemma-4-26b-a4b-it" });
    expect(body.database).toMatchObject({ kind: "mongodb", ok: true });
    expect(body.services).toEqual({ google: true, serpapi: true, voice: { configured: true, live: true }, sentry: true });
    expect(body.caps.quests).toBe(5);
    expect(body.commit).toBe("0123456");
    const text = JSON.stringify(body);
    for (const secret of [GOOGLE_KEY, "serp-secret-123", "el-secret-456", "db.example.net", "health-test", "abc@o1"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("is ready=false (still 200) when Google is chosen without its key, or a model is not Gemma", async () => {
    const noKey = await healthReport({ env: env({ GEMMA_PROVIDER: "google" }) });
    expect(noKey.status).toBe(200);
    expect(noKey.body.ready).toBe(false);
    expect(noKey.body.models.writer).toEqual({ ok: false, error: "GOOGLE_GENERATIVE_AI_API_KEY is not set" });

    const closed = await healthReport({
      env: env({ GEMMA_PROVIDER: "google", GOOGLE_GENERATIVE_AI_API_KEY: GOOGLE_KEY, GEMMA_WRITER_MODEL: "gemini-3-pro" }),
    });
    expect(closed.body.ready).toBe(false);
    expect(closed.body.models.writer.ok).toBe(false);
    expect(closed.body.models.reader.ok).toBe(true);
  });

  it("returns 503 without driver text when the database does not answer", async () => {
    const ping = async () => {
      throw new Error("getaddrinfo ENOTFOUND db.example.net");
    };
    const { status, body } = await healthReport({ env: env({ MONGODB_URI: URI }), ping });
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.database).toEqual({ kind: "mongodb", ok: false, error: "unreachable" });
    expect(JSON.stringify(body)).not.toContain("db.example.net");
  });

  it("times out a hanging ping", async () => {
    vi.useFakeTimers();
    try {
      const pending = healthReport({ env: env({ MONGODB_URI: URI }), ping: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(DB_PING_TIMEOUT_MS + 1);
      const { status, body } = await pending;
      expect(status).toBe(503);
      expect(body.database).toEqual({ kind: "mongodb", ok: false, error: "no answer in time" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("pings the database at most once per cache window", async () => {
    const ping = vi.fn(async () => {});
    const e = env({ MONGODB_URI: URI });
    await healthReport({ env: e, ping, now: 1_000 });
    await healthReport({ env: e, ping, now: 1_000 + DB_PING_CACHE_MS - 1 });
    expect(ping).toHaveBeenCalledTimes(1);
    await healthReport({ env: e, ping, now: 1_000 + DB_PING_CACHE_MS });
    expect(ping).toHaveBeenCalledTimes(2);
  });
});
