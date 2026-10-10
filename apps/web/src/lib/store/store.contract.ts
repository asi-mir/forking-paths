import { beforeEach, describe, expect, it } from "vitest";
import { threeStop } from "@/quest/__fixtures__";
import { AttemptSchema, QuestSchema, RunSchema, type Attempt, type PathStep, type Quest } from "@/quest/schema";
import { validateQuest } from "@/quest/validate";
import { budgetTake, findReusableQuest, nearestSavedQuest } from "../budget";
import type { Store } from "./types";

/**
 * The behaviour both stores must share. `memory.test.ts` runs it on the in-memory store,
 * `mongo.test.ts` on a real MongoDB (only when MONGODB_URI is set).
 */

/** A valid quest built by the validator from the 3-stop fixture. */
export function validQuest(over: Partial<Quest> = {}): Quest {
  const f = threeStop();
  const r = validateQuest(f.writer, f.facts, f.candidates, f.opts);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return { ...r.quest, ...over };
}

const BASE = { lat: 41.025, lng: 28.975 };

const step = (placeId: string, over: Partial<PathStep> = {}): PathStep => ({
  placeId,
  status: "passed",
  observed: "a carved verse",
  cue: "writing",
  bridge: null,
  notTaken: [],
  ...over,
});

const attempt = (runId: string, placeId: string, at: string, over: Partial<Attempt> = {}): Attempt => ({
  questId: "q1",
  runId,
  placeId,
  at,
  distanceM: 12.5,
  accuracyM: 8,
  verdict: { plausible: true, confidence: 0.8, observed: "an inscription", cue: "writing" },
  passed: true,
  provider: "ollama",
  latencyMs: 4200,
  storedVerdict: undefined, // an optional field left undefined must not come back as null
  ...over,
});

export type MakeStore = (opts?: { now?: () => Date }) => Store;

export function storeContract(name: string, make: MakeStore, reset: () => Promise<void> = async () => {}) {
  describe(`${name} store`, () => {
    let store: Store;
    beforeEach(async () => {
      await reset();
      store = make();
    });

    describe("quests", () => {
      it("saves a quest with an id and a rounded centre, and reads it back unchanged", async () => {
        const saved = await store.saveQuest(
          validQuest({ center: { lat: 41.02549, lng: 28.97512 }, demo: undefined, editedByHand: undefined }),
        );
        expect(saved.id).toMatch(/^[0-9a-f]{24}$/);
        expect(saved.center).toEqual({ lat: 41.025, lng: 28.975 });
        const back = await store.getQuest(saved.id);
        expect(back).toEqual(saved);
        // No optional field comes back as null: the quest still parses.
        expect(QuestSchema.safeParse(back).success).toBe(true);
      });

      it("keeps a given id and replaces the quest when saved again", async () => {
        await store.saveQuest(validQuest({ id: "demo-quest", title: "First" }));
        await store.saveQuest(validQuest({ id: "demo-quest", title: "Second" }));
        expect((await store.getQuest("demo-quest"))?.title).toBe("Second");
        expect(await store.questsNear(BASE.lat, BASE.lng, 1)).toHaveLength(1);
      });

      it("returns null for an unknown quest", async () => {
        expect(await store.getQuest("nope")).toBeNull();
      });

      it("refuses a ready quest whose reveal cites a fact it does not carry", async () => {
        const q = validQuest();
        q.places[0].reveal.factIds = ["F99"];
        await expect(store.saveQuest(q)).rejects.toThrow(/F99/);
      });

      it("finds quests near a point, nearest first, within the radius", async () => {
        // 0.001° of latitude is ~111 m.
        const near = await store.saveQuest(validQuest({ title: "near", center: { lat: BASE.lat + 0.002, lng: BASE.lng } }));
        const mid = await store.saveQuest(validQuest({ title: "mid", center: { lat: BASE.lat - 0.004, lng: BASE.lng } }));
        await store.saveQuest(validQuest({ title: "far", center: { lat: BASE.lat + 0.02, lng: BASE.lng } }));
        await store.saveQuest(validQuest({ title: "failed", status: "failed", center: BASE }));
        await store.saveQuest(validQuest({ title: "turkish", lang: "tr", center: BASE }));

        const hits = await store.questsNear(BASE.lat, BASE.lng, 0.5, { lang: "en" });
        expect(hits.map((h) => h.quest.title)).toEqual(["near", "mid"]);
        expect(hits[0].quest.id).toBe(near.id);
        expect(hits[1].quest.id).toBe(mid.id);
        expect(hits[0].distanceM).toBeGreaterThan(200);
        expect(hits[0].distanceM).toBeLessThan(245);
        expect(hits[1].distanceM).toBeGreaterThan(420);
        expect(hits[1].distanceM).toBeLessThan(470);

        expect((await store.questsNear(BASE.lat, BASE.lng, Infinity, { lang: "en" })).map((h) => h.quest.title)).toEqual([
          "near",
          "mid",
          "far",
        ]);
        expect((await store.questsNear(BASE.lat, BASE.lng, 0.1)).map((h) => h.quest.title)).toEqual(["turkish"]);
        expect((await store.questsNear(BASE.lat, BASE.lng, 0.1, { status: "any", lang: "en" })).map((h) => h.quest.title)).toEqual([
          "failed",
        ]);
        expect(await store.questsNear(BASE.lat, BASE.lng, 1, { lang: "en", minutes: 25 })).toEqual([]);
        expect(await store.questsNear(BASE.lat, BASE.lng, 1, { lang: "en", limit: 1 })).toHaveLength(1);
      });

      it("reuses a quest within ~500 m, and offers the nearest one within ~3 km when over the cap", async () => {
        await store.saveQuest(validQuest({ title: "other city", center: { lat: BASE.lat + 0.05, lng: BASE.lng } }));
        expect(await nearestSavedQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 15 }, { store })).toBeNull();
        await store.saveQuest(validQuest({ title: "far", center: { lat: BASE.lat + 0.02, lng: BASE.lng } }));
        expect(await findReusableQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 15 }, { store })).toBeNull();
        expect((await nearestSavedQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 15 }, { store }))?.quest.title).toBe("far");
        // No 25-minute quest is saved: the nearest of the other length is offered.
        expect((await nearestSavedQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 25 }, { store }))?.quest.title).toBe("far");

        await store.saveQuest(validQuest({ title: "close", center: { lat: BASE.lat + 0.004, lng: BASE.lng } }));
        expect((await findReusableQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 15 }, { store }))?.quest.title).toBe("close");
        expect(await findReusableQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 25 }, { store })).toBeNull();
        expect(await nearestSavedQuest(BASE.lat, BASE.lng, { lang: "tr", minutes: 15 }, { store })).toBeNull();
      });

      it("does not reuse a quest with a gated place (it may be closed now)", async () => {
        const gated = validQuest({ title: "gated", center: { lat: BASE.lat + 0.001, lng: BASE.lng } });
        gated.places = gated.places.map((p, i) => (i === 1 ? { ...p, gated: true } : p));
        await store.saveQuest(gated);
        expect(await findReusableQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 15 }, { store })).toBeNull();
        expect(await nearestSavedQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 15 }, { store })).toBeNull();
        await store.saveQuest(validQuest({ title: "open", center: { lat: BASE.lat + 0.002, lng: BASE.lng } }));
        expect((await findReusableQuest(BASE.lat, BASE.lng, { lang: "en", minutes: 15 }, { store }))?.quest.title).toBe("open");
      });
    });

    describe("runs and attempts", () => {
      it("starts a run, appends each place once, and finishes it once", async () => {
        const run = await store.startRun({ questId: "q1", userAgent: "test" });
        expect(RunSchema.safeParse(run).success).toBe(true);
        expect(run.path).toEqual([]);

        await store.appendToPath(run.id, step("P1", { notTaken: [{ to: "P3", cue: "water" }] }));
        const twice = await store.appendToPath(run.id, step("P1", { observed: "again" }));
        expect(twice?.path).toHaveLength(1);
        expect(twice?.path[0].observed).toBe("a carved verse");
        const after = await store.appendToPath(run.id, step("P2", { cue: null, status: "skipped", observed: null }));
        expect(after?.path.map((s) => s.placeId)).toEqual(["P1", "P2"]);

        const done = await store.finishRun(run.id, { screenOnMs: 60_000, pocketMs: 540_000, peeks: 1, stopsFound: 2, score: 25 });
        expect(done?.finishedAt).toBeDefined();
        expect(done?.score).toBe(25);
        const again = await store.finishRun(run.id, { screenOnMs: 1, pocketMs: 1, peeks: 0, stopsFound: 3, score: 99 });
        expect(again?.score).toBe(25);
        expect(again?.finishedAt).toBe(done?.finishedAt);

        const back = await store.getRun(run.id);
        expect(back).toEqual(again);
        expect(RunSchema.safeParse(back).success).toBe(true);
      });

      it("returns null for an unknown run", async () => {
        expect(await store.getRun("nope")).toBeNull();
        expect(await store.appendToPath("nope", step("P1"))).toBeNull();
        expect(await store.finishRun("nope", { screenOnMs: 0, pocketMs: 0, peeks: 0, stopsFound: 0, score: 0 })).toBeNull();
      });

      it("refuses a second run with the same id", async () => {
        await store.startRun({ questId: "q1", id: "fixed-run" });
        await expect(store.startRun({ questId: "q1", id: "fixed-run" })).rejects.toThrow();
      });

      it("stores attempts and lists them per run and place, oldest first", async () => {
        await store.saveAttempt(attempt("r1", "P1", "2026-10-10T10:00:00.000Z", { passed: false, verdict: null, distanceM: 180 }));
        await store.saveAttempt(attempt("r1", "P2", "2026-10-10T10:05:00.000Z"));
        await store.saveAttempt(attempt("r1", "P1", "2026-10-10T10:02:00.000Z", { storedVerdict: true }));
        await store.saveAttempt(attempt("r2", "P1", "2026-10-10T10:01:00.000Z"));

        const p1 = await store.attemptsFor("r1", "P1");
        expect(p1.map((a) => a.at)).toEqual(["2026-10-10T10:00:00.000Z", "2026-10-10T10:02:00.000Z"]);
        expect(p1[0].verdict).toBeNull();
        expect(p1[1].storedVerdict).toBe(true);
        expect(p1.every((a) => AttemptSchema.safeParse(a).success)).toBe(true);
        expect(await store.attemptsFor("r1")).toHaveLength(3);
      });
    });

    describe("clips and cache", () => {
      it("stores a clip's bytes and reads them back", async () => {
        const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0, 1, 2, 255]);
        await store.putClip({ id: "abc", text: "Lock your phone. Go.", voiceId: "v", modelId: "m", mp3 });
        const clip = await store.getClip("abc");
        expect(clip?.text).toBe("Lock your phone. Go.");
        expect([...(clip?.mp3 ?? [])]).toEqual([...mp3]);
        expect(await store.getClip("missing")).toBeNull();
      });

      it("returns a cached payload until it is 7 days old", async () => {
        let t = new Date("2026-10-10T12:00:00Z").getTime();
        const timed = make({ now: () => new Date(t) });
        await timed.cacheSet("wikipedia:41.025,28.975:geosearch", "wikipedia", { pages: [{ title: "A" }] });
        expect(await timed.cacheGet("wikipedia:41.025,28.975:geosearch")).toEqual({ pages: [{ title: "A" }] });
        t += 6 * 24 * 3600 * 1000;
        expect(await timed.cacheGet("wikipedia:41.025,28.975:geosearch")).not.toBeNull();
        t += 2 * 24 * 3600 * 1000;
        expect(await timed.cacheGet("wikipedia:41.025,28.975:geosearch")).toBeNull();
        expect(await timed.cacheGet("missing")).toBeNull();
      });
    });

    describe("budget counters", () => {
      it("refuses a take once the cap is reached", async () => {
        expect(await store.counterTake("2026-10-10:quests", 1, 2)).toEqual({ ok: true, used: 1 });
        expect(await store.counterTake("2026-10-10:quests", 1, 2)).toEqual({ ok: true, used: 2 });
        expect(await store.counterTake("2026-10-10:quests", 1, 2)).toEqual({ ok: false, used: 2 });
        expect(await store.counterUsed("2026-10-10:quests")).toBe(2);
        expect(await store.counterTake("2026-10-11:quests", 1, 2)).toEqual({ ok: true, used: 1 });
      });

      it("refuses a take larger than what is left, and takes nothing", async () => {
        expect((await store.counterTake("d:tts-chars", 900, 1000)).ok).toBe(true);
        expect(await store.counterTake("d:tts-chars", 200, 1000)).toEqual({ ok: false, used: 900 });
        expect(await store.counterTake("d:tts-chars", 100, 1000)).toEqual({ ok: true, used: 1000 });
        expect(await store.counterTake("new:tts-chars", 2000, 1000)).toEqual({ ok: false, used: 0 });
      });

      it("never passes the cap under concurrent takes", async () => {
        const results = await Promise.all(Array.from({ length: 12 }, () => store.counterTake("race:serpapi", 1, 5)));
        expect(results.filter((r) => r.ok)).toHaveLength(5);
        expect(await store.counterUsed("race:serpapi")).toBe(5);
      });

      it("budgetTake uses the daily cap from the environment and the UTC day", async () => {
        const env = { BUDGET_QUESTS_PER_DAY: "2" } as unknown as NodeJS.ProcessEnv;
        const now = new Date("2026-10-10T23:30:00Z"); // 02:30 on the 11th in Istanbul, still the 10th in UTC
        const take = () => budgetTake("quests", 1, { store, env, now });
        expect((await take()).ok).toBe(true);
        expect(await take()).toEqual({ ok: true, service: "quests", used: 2, cap: 2, left: 0 });
        expect(await take()).toEqual({ ok: false, service: "quests", used: 2, cap: 2, left: 0 });
        expect(await store.counterUsed("2026-10-10:quests")).toBe(2);
        const tomorrow = new Date("2026-10-11T00:00:01Z");
        expect((await budgetTake("quests", 1, { store, env, now: tomorrow })).ok).toBe(true);
      });
    });
  });
}
