import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, setStore, type Store } from "@/lib/store";
import { setVoiceClient } from "@/lib/voice";
import type { ModelCallMeta } from "@/lib/json";
import type { ReadResult } from "@/mastra/agents/reader";
import { mastra } from "@/mastra";
import { afterPhoto, lastPhoto, parkedCount, WALK_STEP_ID } from "@/mastra/workflows/play-quest";
import { reasonBridge } from "./bridge";
import { DEMO_QUEST_ID, demoQuest } from "./demo";
import { placeById } from "./routes";
import type { PhotoInput } from "./run";
import { RunError } from "./run";
import type { Verdict } from "./schema";
import { startWalk, walkPhoto } from "./walk";

// The real photo check and fork rule; only Gemma is replaced (no network). Mastra runs on its
// in-memory storage here (no MONGODB_URI in unit tests).
let nextVerdict: Verdict | Error = { plausible: true, confidence: 0.9, observed: "bronze spout over a stone basin", cue: "water" };
let reads = 0;
vi.mock("./photo-check", async (importOriginal) => {
  const real = await importOriginal<typeof import("./photo-check")>();
  return {
    ...real,
    checkPhoto: (input: Parameters<typeof real.checkPhoto>[0], options: Parameters<typeof real.checkPhoto>[1] = {}) =>
      real.checkPhoto(input, {
        ...options,
        env: { GEMMA_PROVIDER: "ollama" },
        read: async (): Promise<ReadResult> => {
          reads++;
          if (nextVerdict instanceof Error) throw nextVerdict;
          return { verdict: nextVerdict, meta: { latencyMs: 900 } as ModelCallMeta, raw: { ...nextVerdict } };
        },
      }),
    chooseNext: (input: Parameters<typeof real.chooseNext>[0], options: Parameters<typeof real.chooseNext>[1] = {}) =>
      real.chooseNext(input, { ...options, byMeaning: async () => null, bridge: async (ctx) => reasonBridge(ctx.link, [], ctx) }),
  };
});

const quest = demoQuest();
const loc = (id: string) => placeById(quest, id)!.location;
// A JPEG header with a marker the test looks for in the snapshot.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0x77, 0x66, 0x55]);
const photo = (placeId: string, at?: { lat: number; lng: number }): PhotoInput => ({
  placeId,
  image: { data: JPEG, mediaType: "image/jpeg" },
  position: at ? { ...at, accuracyM: 8 } : null,
});

const workflow = () => mastra.getWorkflow("playQuest");
async function snapshot(runId: string) {
  const s = await workflow().getWorkflowRunById(runId);
  if (!s) throw new Error("no snapshot");
  return s;
}
const pausedAt = async (runId: string) => {
  const s = await snapshot(runId);
  const steps = s.steps as Record<string, { status?: string; suspendPayload?: Record<string, unknown> }>;
  return { status: s.status, payload: steps[WALK_STEP_ID]?.suspendPayload };
};

let store: Store;
beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
  setVoiceClient(null);
  reads = 0;
  nextVerdict = { plausible: true, confidence: 0.9, observed: "bronze spout over a stone basin", cue: "water" };
});
afterEach(() => setStore(undefined));
afterAll(() => setVoiceClient(undefined));

describe("the paused walk (play-quest)", () => {
  it("pauses at each stop, stays on a stop when too far, and ends with the finale and the case file", async () => {
    const start = await startWalk(DEMO_QUEST_ID, undefined);
    expect(start.first.placeId).toBe("P1");
    expect(await pausedAt(start.runId)).toMatchObject({ status: "suspended", payload: { placeId: "P1", stop: 1, of: 3, last: null } });

    const P1 = loc("P1");
    const far = await walkPhoto(start.runId, photo("P1", { lat: P1.lat + 0.004, lng: P1.lng }));
    expect(far).toMatchObject({ status: "too-far", retriesLeft: 1 });
    expect(await pausedAt(start.runId)).toMatchObject({
      status: "suspended",
      payload: { placeId: "P1", stop: 1, last: { status: "too-far", retriesLeft: 1 } },
    });

    const r1 = await walkPhoto(start.runId, photo("P1", P1));
    expect(r1).toMatchObject({ status: "passed", next: { chosenBy: "cue", stop: { placeId: "P3", stop: 2 } } });
    expect(await pausedAt(start.runId)).toMatchObject({ status: "suspended", payload: { placeId: "P3", stop: 2, last: null } });

    nextVerdict = { plausible: true, confidence: 0.85, observed: "marble basin under a pointed arch", cue: null };
    const r2 = await walkPhoto(start.runId, photo("P3", loc("P3")));
    expect(r2).toMatchObject({ status: "passed", next: { stop: { placeId: "P4", stop: 3 } } });

    const r3 = await walkPhoto(start.runId, photo("P4"));
    if (r3.status !== "passed") throw new Error(`expected passed, got ${r3.status}`);
    expect(r3.end!.caseFile.route.map((s) => s.placeId)).toEqual(["P1", "P3", "P4"]);

    const done = await snapshot(start.runId);
    expect(done.status).toBe("success");
    const result = done.result as { caseFile: { route: { placeId: string; observed: string | null }[]; notTaken: unknown[] }; finale: string };
    expect(result.caseFile.route.map((s) => s.placeId)).toEqual(["P1", "P3", "P4"]);
    expect(result.caseFile.route[0].observed).toBe("bronze spout over a stone basin");
    expect(result.caseFile.notTaken).toHaveLength(1);
    expect(result.finale).toBe(quest.finale.text);

    // The photo never reached the snapshot (resume data holds a key only), and none is parked.
    const raw = JSON.stringify(done);
    expect(raw).not.toMatch(/image|mediaType|255,216|"data"/);
    expect(parkedCount()).toBe(0);
    expect((await store.getRun(start.runId))!.path).toHaveLength(3);
  });

  it("keeps the walk paused when the reader is down, and answers a repeated photo from the record", async () => {
    const { runId } = await startWalk(DEMO_QUEST_ID, undefined);
    nextVerdict = new Error("connect ECONNREFUSED");
    await expect(walkPhoto(runId, photo("P1"))).rejects.toMatchObject({ code: "reader-unavailable", status: 503 });
    expect(await pausedAt(runId)).toMatchObject({ status: "suspended", payload: { placeId: "P1", last: { status: "error" } } });

    await expect(walkPhoto(runId, photo("P4"))).rejects.toBeInstanceOf(RunError); // another stop: 409
    expect(await pausedAt(runId)).toMatchObject({ status: "suspended", payload: { placeId: "P1" } });

    nextVerdict = { plausible: true, confidence: 0.9, observed: "an inscription", cue: "writing" };
    const first = await walkPhoto(runId, photo("P1", loc("P1")));
    const again = await walkPhoto(runId, photo("P1", loc("P1")));
    expect(again).toEqual(first);
    expect(reads).toBe(2); // the failed read and the first pass; the repeat made no call
    expect(await pausedAt(runId)).toMatchObject({ status: "suspended", payload: { placeId: "P2", stop: 2 } });
    expect(parkedCount()).toBe(0);
  });

  it("takes two photos for the same stop one at a time", async () => {
    const { runId } = await startWalk(DEMO_QUEST_ID, undefined);
    const [a, b] = await Promise.all([walkPhoto(runId, photo("P1", loc("P1"))), walkPhoto(runId, photo("P1", loc("P1")))]);
    expect(b).toEqual(a);
    expect(reads).toBe(1);
    expect((await store.getRun(runId))!.path).toHaveLength(1);
    expect(await pausedAt(runId)).toMatchObject({ status: "suspended", payload: { placeId: "P3", stop: 2 } });
  });

  it("falls back to the plain record for a run with no paused walk", async () => {
    const run = await store.startRun({ questId: DEMO_QUEST_ID });
    const out = await walkPhoto(run.id, photo("P1", loc("P1")));
    expect(out).toMatchObject({ status: "passed", next: { stop: { placeId: "P3" } } });
    expect((await store.getRun(run.id))!.path).toHaveLength(1);
  });
});

describe("afterPhoto and lastPhoto", () => {
  const state = { questId: "q", placeId: "P1", stop: 1, of: 3, done: false };
  it("stays on the stop after a miss and keeps the reader's text only", () => {
    const tooFar = { status: "too-far" as const, placeId: "P1", hint: { line: { text: "x" }, distanceM: 420, direction: "S" as const }, retriesLeft: 1 };
    expect(afterPhoto(state, tooFar)).toEqual(state);
    expect(lastPhoto(tooFar)).toEqual({ status: "too-far", placeId: "P1", observed: null, retriesLeft: 1, distanceM: 420 });
  });
});
