import { describe, expect, it } from "vitest";
import {
  CaseFileSchema,
  FinishResponseSchema,
  PHOTO_RETRIES,
  type PhotoResult,
  StartRunResponseSchema,
} from "@/quest/api";
import { createMockApi, type MockControls, mockQuest } from "./mock";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" });
const at = { lat: 41.026, lng: 28.975, accuracy: 12 };

function setup(controls: MockControls = {}) {
  let c = controls;
  const api = createMockApi({ storage: memory(), delayMs: 0, controls: () => c, newId: () => "test01" });
  return { api, set: (next: MockControls) => (c = next) };
}

type Done = Extract<PhotoResult, { status: "passed" | "skipped" }>;

async function walk(minutes: 15 | 25, cues: MockControls["cue"][]) {
  const { api, set } = setup();
  const quest = await api.createQuest({ lat: at.lat, lng: at.lng, minutes, lang: "en" });
  const start = StartRunResponseSchema.parse(await api.startRun({ questId: quest.questId }));
  let stop = start.first;
  const results: Done[] = [];
  let fork = 0;
  for (;;) {
    set({ cue: stop.isFork ? cues[fork++] : undefined });
    const r = await api.sendPhoto(start.runId, jpeg, { placeId: stop.placeId, ...at });
    expect(r.status).toBe("passed");
    const done = r as Done;
    results.push(done);
    if (done.end) break;
    stop = done.next!.stop;
  }
  return { api, start, results, end: results.at(-1)!.end! };
}

describe("mock adapter", () => {
  it("starts a run with every clip to preload and the ambience and stingers", async () => {
    const { api } = setup();
    const start = await api.startRun({ questId: "mock-quest-15" });
    expect(start.voice).toBe(true);
    expect(start.first).toMatchObject({ stop: 1, of: 3, isFork: true });
    expect(start.preload).toContain(start.ambienceClipId);
    expect(start.preload).toContain(start.briefing.clipId);
    expect(start.preload).toContain(start.first.clue.clipId);
    expect(start.stingers.found).toBeDefined();
  });

  it("is text only when voice is off", async () => {
    const { api } = setup({ voice: false });
    const start = await api.startRun({ questId: "mock-quest-15" });
    expect(start).toMatchObject({ voice: false, preload: [], stingers: {} });
    expect(start.briefing.clipId).toBeUndefined();
  });

  it("takes the fork both ways and both routes end at the answer", async () => {
    const quest = mockQuest(15);
    const byWriting = await walk(15, ["writing"]);
    const byWater = await walk(15, ["water"]);
    const second = (w: typeof byWriting) => w.results[1].placeId;
    expect(second(byWriting)).not.toBe(second(byWater));
    for (const w of [byWriting, byWater]) {
      expect(w.results).toHaveLength(quest.stopsPerRun);
      expect(w.results.at(-1)!.placeId).toBe(quest.answerPlaceId);
      expect(w.results[0].next!.chosenBy).toBe("cue");
    }
  });

  it("names the detail Gemma saw in the bridge line", async () => {
    const { results } = await walk(15, ["water"]);
    const first = results[0];
    expect(first.verdict!.cue).toBe("water");
    expect(first.next!.bridge.line.text.toLowerCase()).toContain(first.verdict!.observed.toLowerCase());
    expect(first.next!.bridge.facts.length).toBeGreaterThan(0);
  });

  it("shows the road not taken and every fact with source, query and link", async () => {
    const { end, results } = await walk(15, ["writing"]);
    const caseFile = CaseFileSchema.parse(end.caseFile);
    expect(caseFile.notTaken).toHaveLength(1);
    expect(caseFile.notTaken[0].taken.to).toBe(results[1].placeId);
    expect(caseFile.notTaken[0].notTaken[0]).toMatchObject({ cue: "water", name: "Test Bathhouse" });
    expect(caseFile.facts).toHaveLength(mockQuest(15).facts.length);
    for (const f of caseFile.facts) {
      expect(f.url).toMatch(/^https:\/\//);
      expect(f.query.length).toBeGreaterThan(0);
      expect(["wikipedia", "serpapi-maps", "serpapi-search"]).toContain(f.source);
    }
    expect(caseFile.route.map((r) => r.placeId)).toEqual(results.map((r) => r.placeId));
  });

  it("walks the 25-minute quest through two forks", async () => {
    const { end } = await walk(25, ["water", "door-window-arch"]);
    expect(end.caseFile.route).toHaveLength(4);
    expect(end.caseFile.notTaken).toHaveLength(2);
  });

  it("says too far with distance and direction, then skips the stop when out of retries", async () => {
    const { api, set } = setup();
    const start = await api.startRun({ questId: "mock-quest-15" });
    set({ far: true, cue: "water" });
    const left: number[] = [];
    for (let i = 0; i < PHOTO_RETRIES; i++) {
      const r = await api.sendPhoto(start.runId, jpeg, { placeId: start.first.placeId, ...at });
      expect(r.status).toBe("too-far");
      if (r.status === "too-far") {
        expect(r.hint.distanceM).toBeGreaterThan(60);
        expect(r.hint.direction).toBe("NE");
        left.push(r.retriesLeft);
      }
    }
    expect(left).toEqual([1, 0]);
    const last = await api.sendPhoto(start.runId, jpeg, { placeId: start.first.placeId, ...at });
    expect(last.status).toBe("skipped");
    if (last.status === "skipped") {
      expect(last.verdict).toBeNull();
      expect(last.reveal.facts.length).toBeGreaterThan(0);
      expect(last.next).not.toBeNull();
    }
  });

  it("asks for another photo when there is no GPS and the photo is not plausible", async () => {
    const { api } = setup({ implausible: true });
    const start = await api.startRun({ questId: "mock-quest-15" });
    const r = await api.sendPhoto(start.runId, jpeg, { placeId: start.first.placeId });
    expect(r.status).toBe("needs-retry");
  });

  it("rejects a photo for the wrong stop", async () => {
    const { api } = setup();
    const start = await api.startRun({ questId: "mock-quest-15" });
    await expect(api.sendPhoto(start.runId, jpeg, { placeId: "P4" })).rejects.toThrow(/different stop/);
  });

  it("scores the finish like the receipt module", async () => {
    const { api, start } = await walk(15, ["writing"]);
    const res = FinishResponseSchema.parse(
      await api.finish(start.runId, { receipt: { screenOnMs: 60_000, pocketMs: 840_000, peeks: 1 } }),
    );
    expect(res).toMatchObject({ stopsFound: 3, score: 340 });
  });
});
