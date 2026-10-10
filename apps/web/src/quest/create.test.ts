import { describe, expect, it, vi } from "vitest";
import { budgetStatus } from "@/lib/budget";
import { createMemoryStore } from "@/lib/store/memory";
import { createQuest, type RunGeneration } from "./create";
import { demoQuest } from "./demo";
import type { GenerateOutput } from "./generate";

const KARAKOY = { lat: 41.0247, lng: 28.9744 };
const env = (cap: number) => ({ BUDGET_QUESTS_PER_DAY: String(cap) }) as unknown as NodeJS.ProcessEnv;

function output(over: Partial<GenerateOutput> = {}): GenerateOutput {
  return {
    status: "ready",
    questId: "q-new",
    validation: { firstTryOk: true, firstTryErrors: [], repaired: false },
    errors: [],
    model: { provider: "google", writer: "gemma-4-31b-it" },
    timings: { researchMs: 10, writeMs: 20 },
    serpapiSearches: 6,
    serpapiCacheHits: 0,
    calls: [],
    drafts: [],
    candidates: 8,
    routeOptions: 4,
    ...over,
  };
}

/** A saved ready quest centred on `at` (the demo quest's content, with a new id). */
async function saved(store: ReturnType<typeof createMemoryStore>, at: { lat: number; lng: number }, minutes = 15) {
  const q = demoQuest();
  return store.saveQuest({ ...q, id: undefined, demo: undefined, center: at, minutes });
}

describe("POST /api/quests logic", () => {
  it("rejects a bad body without any call", async () => {
    const generate = vi.fn<RunGeneration>();
    const res = await createQuest({ lat: 200, lng: 0, minutes: 20 }, { generate, store: createMemoryStore() });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "bad-request" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("reuses a saved quest within ~500 m without generating or taking budget", async () => {
    const store = createMemoryStore();
    const q = await saved(store, { lat: 41.026, lng: 28.975 });
    const generate = vi.fn<RunGeneration>();
    const res = await createQuest({ ...KARAKOY, minutes: 15, lang: "en" }, { generate, store, env: env(3) });
    expect(res).toMatchObject({ status: 200, body: { questId: q.id, reused: true } });
    expect(generate).not.toHaveBeenCalled();
    expect((await budgetStatus("quests", { store, env: env(3) })).used).toBe(0);
  });

  it("does not reuse a quest of another length", async () => {
    const store = createMemoryStore();
    await saved(store, KARAKOY, 25);
    const generate = vi.fn<RunGeneration>(async () => ({ ok: true, output: output() }));
    const res = await createQuest({ ...KARAKOY, minutes: 15 }, { generate, store, env: env(3) });
    expect(res.body).toEqual({ questId: "q-new", reused: false });
  });

  it("generates when nothing is near, takes one quest from today's budget, and passes the input on", async () => {
    const store = createMemoryStore();
    const generate = vi.fn<RunGeneration>(async () => ({ ok: true, output: output() }));
    const res = await createQuest({ ...KARAKOY, minutes: 25, lang: "en", timeZone: "Europe/Istanbul" }, { generate, store, env: env(3) });
    expect(res).toEqual({ status: 200, body: { questId: "q-new", reused: false } });
    // The workflow only ever sees the centre rounded to ~100 m.
    expect(generate).toHaveBeenCalledWith({ lat: 41.025, lng: 28.974, minutes: 25, lang: "en", timeZone: "Europe/Istanbul" });
    expect((await budgetStatus("quests", { store, env: env(3) })).used).toBe(1);
  });

  it("over the cap: offers the nearest saved quest and makes no generation call", async () => {
    const store = createMemoryStore();
    const far = await saved(store, { lat: 41.04, lng: 28.99 }); // ~2 km away: too far to reuse
    const generate = vi.fn<RunGeneration>();
    const res = await createQuest({ ...KARAKOY, minutes: 15 }, { generate, store, env: env(0) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ questId: far.id, reused: true, overCap: true });
    expect((res.body as { distanceM: number }).distanceM).toBeGreaterThan(500);
    expect(generate).not.toHaveBeenCalled();
  });

  it("over the cap: prefers a saved quest of the same length", async () => {
    const store = createMemoryStore();
    await saved(store, { lat: 41.03, lng: 28.98 }, 15); // ~800 m, other length
    const same = await saved(store, { lat: 41.04, lng: 28.99 }, 25); // ~2 km, same length
    const res = await createQuest({ ...KARAKOY, minutes: 25 }, { generate: vi.fn<RunGeneration>(), store, env: env(0) });
    expect(res.body).toMatchObject({ questId: same.id, overCap: true });
  });

  it("over the cap: never offers a quest in another city", async () => {
    const store = createMemoryStore();
    await saved(store, { lat: 41.9, lng: 12.48 }); // Rome, ~1,370 km away
    const res = await createQuest({ ...KARAKOY, minutes: 15 }, { generate: vi.fn<RunGeneration>(), store, env: env(0) });
    expect(res).toMatchObject({ status: 429, body: { code: "over-cap" } });
  });

  it("over the cap with nothing saved: 429 over-cap", async () => {
    const generate = vi.fn<RunGeneration>();
    const res = await createQuest({ ...KARAKOY, minutes: 15 }, { generate, store: createMemoryStore(), env: env(0) });
    expect(res).toMatchObject({ status: 429, body: { code: "over-cap" } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("maps failures to plain errors", async () => {
    const cases: [Awaited<ReturnType<RunGeneration>>, number, string][] = [
      [{ ok: false, message: "Not enough places close together here.", code: "few-places" }, 422, "few-places"],
      [{ ok: false, message: "timed out", code: "writer-failed" }, 503, "writer-failed"],
      [{ ok: true, output: output({ status: "failed", questId: undefined, errors: ["x"] }) }, 502, "invalid-quest"],
    ];
    for (const [result, status, code] of cases) {
      const res = await createQuest({ ...KARAKOY, minutes: 15 }, { generate: async () => result, store: createMemoryStore(), env: env(3) });
      expect(res).toMatchObject({ status, body: { code } });
    }
  });

  it("a second request for the same spot waits for the first generation", async () => {
    const store = createMemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const generate = vi.fn<RunGeneration>(async () => {
      await gate;
      return { ok: true, output: output() };
    });
    const a = createQuest({ ...KARAKOY, minutes: 15 }, { generate, store, env: env(3) });
    const b = createQuest({ lat: 41.0249, lng: 28.9741, minutes: 15 }, { generate, store, env: env(3) });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toEqual(rb.body);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
