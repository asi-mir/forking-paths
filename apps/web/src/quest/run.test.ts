import { describe, expect, it, vi } from "vitest";
import type { ModelCallMeta } from "@/lib/json";
import type { ReaderInput, ReadResult } from "@/mastra/agents/reader";
import { PHOTO_RETRIES, PhotoResultSchema, StartRunResponseSchema, type PhotoResult } from "./api";
import { reasonBridge, type Bridge, type BridgeContext } from "./bridge";
import { demoQuest } from "./demo";
import { checkPhoto, chooseNext } from "./photo-check";
import { placeById } from "./routes";
import {
  caseFile,
  finishResponse,
  finishRun,
  missesAt,
  ReaderDownError,
  replayResult,
  runPosition,
  RunError,
  startRun,
  submitPhoto,
  type PhotoInput,
  type RunDeps,
  type RunState,
} from "./run";
import type { Attempt, Run, RunVoice, Verdict } from "./schema";

const OLLAMA = { GEMMA_PROVIDER: "ollama" };
const quest = demoQuest(); // P1 (fork: writing → P2, water → P3) → P2 | P3 → P4 (answer)
const at = (id: string) => ({ ...placeById(quest, id)!.location, accuracyM: 8 });
const far = (id: string) => ({ lat: placeById(quest, id)!.location.lat + 400 / 111_195, lng: placeById(quest, id)!.location.lng, accuracyM: 10 });
const image = { data: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" };

const OBSERVED = {
  writing: "carved marble panel with a gilded inscription",
  water: "bronze spout over a stone basin",
  plain: "arched stone niche with a basin",
} as const;
const verdict = (v: Partial<Verdict> = {}): Verdict => ({ plausible: true, confidence: 0.9, observed: OBSERVED.plain, cue: null, ...v });

/** The real photo check and fork rule (T08); only the model calls are fakes. */
function deps(read: (input: ReaderInput) => Verdict | Error, bridge?: (ctx: BridgeContext) => Bridge): RunDeps & { reads: ReaderInput[] } {
  const reads: ReaderInput[] = [];
  return {
    reads,
    check: (input, options) =>
      checkPhoto(input, {
        ...options,
        env: OLLAMA,
        read: async (i): Promise<ReadResult> => {
          reads.push(i);
          const v = read(i);
          if (v instanceof Error) throw v;
          return { verdict: v, meta: { latencyMs: 900 } as ModelCallMeta, raw: { ...v } };
        },
      }),
    choose: (input, options) =>
      chooseNext(input, {
        ...options,
        env: OLLAMA,
        byMeaning: async () => null,
        bridge: async (ctx) => (bridge ? bridge(ctx) : reasonBridge(ctx.link, [], ctx)),
      }),
    speak: vi.fn(async (text: string) => `clip-${text.length}`),
    now: () => new Date("2026-10-10T09:00:00Z"),
  };
}

const newRun = (voice?: RunVoice): Run => ({
  id: "run-1",
  questId: "demo-karakoy",
  path: [],
  startedAt: "2026-10-10T08:55:00Z",
  ...(voice ? { voice } : {}),
});

/** A walk against an in-memory record: saves each attempt and step like the service does. */
function walk(d: RunDeps, run = newRun()) {
  const state: { run: Run; attempts: Attempt[] } = { run, attempts: [] };
  return {
    state,
    async photo(input: Omit<PhotoInput, "image">): Promise<PhotoResult> {
      const out = await submitPhoto(quest, state as RunState, { image, ...input }, d);
      if (out.attempt) state.attempts.push(out.attempt);
      if (out.step) state.run = { ...state.run, path: [...state.run.path, out.step] };
      expect(PhotoResultSchema.safeParse(out.result).success).toBe(true);
      return out.result;
    },
  };
}

describe("startRun", () => {
  it("gives the briefing and the first clue, text only without voice", () => {
    const res = startRun(quest, newRun(), { voice: false, preload: [], stingers: {} });
    expect(StartRunResponseSchema.parse(res)).toEqual(res);
    expect(res).toMatchObject({ runId: "run-1", questId: "demo-karakoy", title: quest.title, voice: false, preload: [] });
    expect(res.first).toMatchObject({ placeId: "P1", stop: 1, of: 3, isFork: true });
    expect(res.first.clue.clipId).toBeUndefined();
    expect(res.briefing.text).toBe(quest.briefing.text.replace(/\[[^\]]+\]\s*/g, "").trim());
  });

  it("attaches the run's clips to each line when it has voice", () => {
    const voice: RunVoice = { on: true, clips: { briefing: "c-brief", "P1.clue": "c-clue", "P1.look": "c-look" } };
    const res = startRun(quest, newRun(voice), {
      voice: true,
      preload: ["c-brief", "c-clue", "c-look", "amb"],
      ambienceClipId: "amb",
      stingers: { found: "f" },
    });
    expect(res.briefing.clipId).toBe("c-brief");
    expect(res.first.clue.clipId).toBe("c-clue");
    expect(res.first.look.clipId).toBe("c-look");
    expect(res).toMatchObject({ voice: true, ambienceClipId: "amb", stingers: { found: "f" } });
  });
});

describe("submitPhoto: a full 3-stop route", () => {
  it("takes the writing branch: P1 → P2 → P4, with the finale and the road not taken", async () => {
    const d = deps((i) => (i.cues?.length ? verdict({ cue: "writing", observed: OBSERVED.writing }) : verdict()));
    const w = walk(d);

    const r1 = await w.photo({ placeId: "P1", position: at("P1") });
    expect(r1).toMatchObject({ status: "passed", placeId: "P1", name: "Bereketzade Fountain" });
    if (r1.status !== "passed") throw new Error("expected passed");
    expect(r1.verdict).toMatchObject({ cue: "writing", source: "live" });
    expect(r1.reveal.facts.map((f) => f.id)).toEqual(["F1"]);
    expect(r1.next).toMatchObject({ chosenBy: "cue", stop: { placeId: "P2", stop: 2, of: 3, isFork: false } });
    // The fallback bridge names the detail and cites the link's facts.
    expect(r1.next!.bridge.line.text).toMatch(/^You photographed the carved marble panel/);
    expect(r1.next!.bridge.facts.map((f) => f.id)).toEqual(["F2", "F3", "F8"]);
    expect(d.reads[0].cues).toEqual(["writing", "water"]);

    const r2 = await w.photo({ placeId: "P2", position: at("P2") });
    expect(r2).toMatchObject({ status: "passed", next: { chosenBy: "only-link", stop: { placeId: "P4", stop: 3 } } });

    const r3 = await w.photo({ placeId: "P4", position: at("P4") });
    if (r3.status !== "passed") throw new Error("expected passed");
    expect(r3.next).toBeNull();
    expect(r3.end!.finale.facts.map((f) => f.id)).toEqual(["F14", "F15", "F16", "F17"]);
    const cf = r3.end!.caseFile;
    expect(cf.route.map((s) => [s.placeId, s.status, s.cue])).toEqual([
      ["P1", "passed", "writing"],
      ["P2", "passed", null],
      ["P4", "passed", null],
    ]);
    expect(cf.notTaken).toEqual([
      expect.objectContaining({ at: "P1", taken: expect.objectContaining({ to: "P2" }), notTaken: [expect.objectContaining({ to: "P3", name: "Hasan Ağa Fountain", cue: "water" })] }),
    ]);
    expect(cf.facts).toHaveLength(quest.facts.length);
    expect(runPosition(quest, w.state.run)).toEqual({ done: true, stop: 3 });
    await expect(w.photo({ placeId: "P4", position: at("P4") })).resolves.toMatchObject({ status: "passed", end: expect.anything() });
    expect(w.state.attempts).toHaveLength(3); // the repeat was answered from the record
  });

  it("takes the water branch: P1 → P3 → P4", async () => {
    const d = deps((i) => (i.cues?.length ? verdict({ cue: "water", observed: OBSERVED.water }) : verdict()));
    const w = walk(d);
    const r1 = await w.photo({ placeId: "P1", position: at("P1") });
    expect(r1).toMatchObject({ status: "passed", next: { chosenBy: "cue", stop: { placeId: "P3" } } });
    await w.photo({ placeId: "P3", position: at("P3") });
    const r3 = await w.photo({ placeId: "P4", position: at("P4") });
    if (r3.status !== "passed") throw new Error("expected passed");
    expect(r3.end!.caseFile.route.map((s) => s.placeId)).toEqual(["P1", "P3", "P4"]);
    expect(r3.end!.caseFile.notTaken[0].notTaken.map((n) => n.to)).toEqual(["P2"]);
  });
});

describe("submitPhoto: misses", () => {
  it("too far: hint, distance and direction with no model call, then passes on the retry", async () => {
    const d = deps(() => verdict({ cue: "water", observed: OBSERVED.water }));
    const w = walk(d);
    const miss = await w.photo({ placeId: "P1", position: far("P1") });
    expect(miss).toMatchObject({ status: "too-far", placeId: "P1", retriesLeft: PHOTO_RETRIES - 1 });
    if (miss.status !== "too-far") throw new Error("expected too-far");
    expect(miss.hint.distanceM).toBeGreaterThan(350);
    expect(miss.hint.direction).toBe("S"); // the place is south of a player 400 m north of it
    expect(miss.hint.line.text).toBe(placeById(quest, "P1")!.hint.text);
    expect(d.reads).toHaveLength(0);
    expect(w.state.attempts[0]).toMatchObject({ passed: false, verdict: null, provider: null });

    const pass = await w.photo({ placeId: "P1", position: at("P1") });
    expect(pass).toMatchObject({ status: "passed", next: { stop: { placeId: "P3" } } });
    expect(missesAt(w.state.attempts, "P1")).toBe(1);
  });

  it("skips the stop after the retries run out: the reveal is still told and the fork goes to the nearest link", async () => {
    const d = deps(() => verdict({ cue: "writing", observed: OBSERVED.writing }));
    const w = walk(d);
    const misses = [];
    for (let i = 0; i < PHOTO_RETRIES; i++) misses.push(await w.photo({ placeId: "P1", position: far("P1") }));
    expect(misses.map((m) => m.status === "too-far" && m.retriesLeft)).toEqual([1, 0]);

    const skip = await w.photo({ placeId: "P1", position: far("P1") });
    if (skip.status !== "skipped") throw new Error(`expected skipped, got ${skip.status}`);
    expect(skip.verdict).toBeNull();
    expect(skip.reveal.facts.map((f) => f.id)).toEqual(["F1"]);
    expect(skip.next!.chosenBy).toBe("nearest");
    expect(["P2", "P3"]).toContain(skip.next!.stop.placeId);
    expect(d.reads).toHaveLength(0);
    expect(w.state.run.path[0]).toMatchObject({ placeId: "P1", status: "skipped", observed: null });
  });

  it("GPS missing: an implausible photo asks for another, a plausible confident one passes", async () => {
    let n = 0;
    const d = deps(() => (n++ === 0 ? verdict({ plausible: false, confidence: 0.9, observed: "a computer screen" }) : verdict({ cue: "water", observed: OBSERVED.water })));
    const w = walk(d);
    const retry = await w.photo({ placeId: "P1" });
    expect(retry).toMatchObject({ status: "needs-retry", retriesLeft: 1, verdict: { plausible: false, source: "live" } });
    const pass = await w.photo({ placeId: "P1" });
    expect(pass).toMatchObject({ status: "passed", verdict: { cue: "water" }, next: { stop: { placeId: "P3" } } });
  });

  it("GPS missing: below 0.7 confidence does not pass", async () => {
    const w = walk(deps(() => verdict({ confidence: 0.69, cue: "water" })));
    await expect(w.photo({ placeId: "P1" })).resolves.toMatchObject({ status: "needs-retry" });
  });

  it("GPS near passes whatever the reader says, and a reader failure falls to the nearest link", async () => {
    const w = walk(deps(() => new Error("timed out")));
    const r = await w.photo({ placeId: "P1", position: at("P1") });
    expect(r).toMatchObject({ status: "passed", verdict: null, next: { chosenBy: "nearest" } });
    if (r.status !== "passed") throw new Error("expected passed");
    expect(r.next!.bridge.line.text).toBe(placeById(quest, "P1")!.links.find((l) => l.to === r.next!.stop.placeId)!.reason);
  });

  it("GPS missing and the reader down: a 503 that saves the attempt but uses no retry", async () => {
    const w = walk(deps(() => new Error("connection refused")));
    const err = await submitPhoto(quest, w.state, { placeId: "P1", image }, deps(() => new Error("down"))).catch((e) => e);
    expect(err).toBeInstanceOf(ReaderDownError);
    expect(err).toMatchObject({ status: 503, code: "reader-unavailable" });
    expect(missesAt([(err as ReaderDownError).attempt], "P1")).toBe(0);
  });
});

describe("submitPhoto: guards", () => {
  it("refuses a photo for another stop, and any photo once the walk is finished", async () => {
    const w = walk(deps(() => verdict()));
    await expect(w.photo({ placeId: "P3", position: at("P3") })).rejects.toMatchObject({ code: "wrong-place", status: 409 });
    w.state.run = { ...w.state.run, finishedAt: "2026-10-10T09:30:00Z" };
    await expect(w.photo({ placeId: "P1", position: at("P1") })).rejects.toBeInstanceOf(RunError);
  });

  it("never follows a next stop that is not a link of the current place", async () => {
    const d = deps(() => verdict({ cue: "water" }));
    const bad: RunDeps = {
      ...d,
      choose: async (input, options) => {
        const real = await d.choose(input, options);
        return { ...real, fork: { ...real.fork, link: { ...real.fork.link, to: "P4" } } };
      },
    };
    await expect(submitPhoto(quest, { run: newRun(), attempts: [] }, { placeId: "P1", image, position: at("P1") }, bad)).rejects.toThrow(
      /not a link of P1/,
    );
  });

  it("voices the bridge only when the run has voice, and attaches reveal and next-clue clips", async () => {
    const voice: RunVoice = { on: true, clips: { "P1.reveal": "c-rev", "P3.clue": "c-p3" } };
    const d = deps(() => verdict({ cue: "water", observed: OBSERVED.water }));
    const r = await walk(d, newRun(voice)).photo({ placeId: "P1", position: at("P1") });
    if (r.status !== "passed") throw new Error("expected passed");
    expect(r.reveal.line.clipId).toBe("c-rev");
    expect(r.next!.stop.clue.clipId).toBe("c-p3");
    expect(r.next!.bridge.line.clipId).toMatch(/^clip-/);

    const silent = deps(() => verdict({ cue: "water" }));
    await walk(silent).photo({ placeId: "P1", position: at("P1") });
    expect(silent.speak).not.toHaveBeenCalled();
  });
});

describe("replayResult", () => {
  it("rebuilds a done stop's answer from the record", async () => {
    const w = walk(deps(() => verdict({ cue: "water", observed: OBSERVED.water })));
    const first = await w.photo({ placeId: "P1", position: at("P1") });
    expect(replayResult(quest, w.state.run, w.state.attempts, "P1")).toEqual(first);
  });
});

describe("caseFile", () => {
  it("lists a skipped stop and the fork it left", () => {
    const cf = caseFile(quest, [
      { placeId: "P1", status: "skipped", observed: null, cue: "water", bridge: "x", notTaken: [{ to: "P2", cue: "writing" }], to: "P3" },
      { placeId: "P3", status: "passed", observed: "a basin", cue: null, bridge: "y", notTaken: [], to: "P4" },
      { placeId: "P4", status: "passed", observed: "stairs", cue: null, bridge: null, notTaken: [], to: null },
    ]);
    expect(cf.route[0]).toMatchObject({ status: "skipped", observed: null });
    expect(cf.notTaken[0]).toMatchObject({ at: "P1", taken: { to: "P3" } });
  });
});

describe("finishRun", () => {
  it("scores passed stops, peeks and the screen-on share, and answers from the stored run", () => {
    const run: Run = {
      ...newRun(),
      path: [
        { placeId: "P1", status: "passed", observed: "x", cue: "water", bridge: "b", notTaken: [] },
        { placeId: "P3", status: "skipped", observed: null, cue: null, bridge: "b", notTaken: [] },
        { placeId: "P4", status: "passed", observed: "y", cue: null, bridge: null, notTaken: [] },
      ],
    };
    const receipt = { screenOnMs: 60_000, pocketMs: 540_000, peeks: 1 };
    const save = finishRun(run, receipt);
    expect(save).toEqual({ stopsFound: 2, score: 2 * 100 - 10 + 50, ...receipt });
    const res = finishResponse({ ...run, ...save, finishedAt: "2026-10-10T09:30:00Z" });
    expect(res).toEqual({ runId: "run-1", stopsFound: 2, score: 240, screenOnShare: 0.1, receipt });
  });
});
