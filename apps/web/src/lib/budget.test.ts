import { describe, expect, it } from "vitest";
import { BUDGET_DEFAULTS, budgetCap, budgetKey, budgetStatus, budgetTake, dayKey } from "./budget";
import { createMemoryStore } from "./store/memory";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe("budgetTake", () => {
  it("refuses once the daily cap is reached, and takes nothing when it refuses", async () => {
    const store = createMemoryStore();
    const opts = { store, env: env({ BUDGET_QUESTS_PER_DAY: "3" }), now: new Date("2026-10-10T09:00:00Z") };
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await budgetTake("quests", 1, opts));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false]);
    expect(results[3]).toEqual({ ok: false, service: "quests", used: 3, cap: 3, left: 0 });
    expect(await budgetStatus("quests", opts)).toEqual({ service: "quests", used: 3, cap: 3, left: 0 });
  });

  it("counts characters for voice, and refuses a line that does not fit what is left", async () => {
    const store = createMemoryStore();
    const opts = { store, env: env({ BUDGET_TTS_CHARS_PER_DAY: "100" }) };
    expect((await budgetTake("tts-chars", 80, opts)).left).toBe(20);
    expect((await budgetTake("tts-chars", 30, opts)).ok).toBe(false);
    expect((await budgetTake("tts-chars", 20, opts)).ok).toBe(true);
  });

  it("keeps each service and each UTC day apart", async () => {
    const store = createMemoryStore();
    const opts = { store, env: env({ BUDGET_QUESTS_PER_DAY: "1", BUDGET_SERPAPI_PER_DAY: "1" }) };
    const day1 = new Date("2026-10-10T23:59:59Z");
    const day2 = new Date("2026-10-11T00:00:00Z");
    expect((await budgetTake("quests", 1, { ...opts, now: day1 })).ok).toBe(true);
    expect((await budgetTake("serpapi", 1, { ...opts, now: day1 })).ok).toBe(true);
    expect((await budgetTake("quests", 1, { ...opts, now: day1 })).ok).toBe(false);
    expect((await budgetTake("quests", 1, { ...opts, now: day2 })).ok).toBe(true);
  });

  it("a cap of 0 turns the service off", async () => {
    const r = await budgetTake("serpapi", 1, { store: createMemoryStore(), env: env({ BUDGET_SERPAPI_PER_DAY: "0" }) });
    expect(r).toMatchObject({ ok: false, used: 0, cap: 0 });
  });

  it("rejects a non-positive amount", async () => {
    await expect(budgetTake("quests", 0, { store: createMemoryStore() })).rejects.toThrow(RangeError);
    await expect(budgetTake("quests", Number.NaN, { store: createMemoryStore() })).rejects.toThrow(RangeError);
  });
});

describe("budgetCap", () => {
  it("reads the environment and falls back to the defaults", () => {
    expect(budgetCap("quests", env({}))).toBe(BUDGET_DEFAULTS.quests);
    expect(budgetCap("serpapi", env({}))).toBe(40);
    expect(budgetCap("tts-chars", env({ BUDGET_TTS_CHARS_PER_DAY: " 2500 " }))).toBe(2500);
    expect(budgetCap("quests", env({ BUDGET_QUESTS_PER_DAY: "lots" }))).toBe(BUDGET_DEFAULTS.quests);
    expect(budgetCap("quests", env({ BUDGET_QUESTS_PER_DAY: "-1" }))).toBe(BUDGET_DEFAULTS.quests);
    expect(budgetCap("quests", env({ BUDGET_QUESTS_PER_DAY: "" }))).toBe(BUDGET_DEFAULTS.quests);
  });
});

describe("dayKey", () => {
  it("uses the UTC date", () => {
    expect(dayKey(new Date("2026-10-11T01:30:00+03:00"))).toBe("2026-10-10");
    expect(budgetKey("tts-chars", new Date("2026-10-11T03:00:00+03:00"))).toBe("2026-10-11:tts-chars");
  });
});
