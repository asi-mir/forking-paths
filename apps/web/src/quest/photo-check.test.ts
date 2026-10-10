import { describe, expect, it, vi } from "vitest";
import { ModelCallError, type ModelCallMeta } from "@/lib/json";
import { scriptedModel, userText } from "@/test/mock-model";
import type { ReaderInput, ReadResult } from "@/mastra/agents/reader";
import { demoQuest } from "./demo";
import { checkPhoto, chooseNext, verdictView, writeBridge } from "./photo-check";
import { placeById } from "./routes";
import type { Verdict } from "./schema";

const OLLAMA = { GEMMA_PROVIDER: "ollama" };
const quest = demoQuest();
const P1 = placeById(quest, "P1")!;
const image = { data: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: "image/jpeg" };
const atP1 = { ...P1.location, accuracyM: 8 };
const far = { lat: P1.location.lat + 400 / 111_195, lng: P1.location.lng, accuracyM: 10 };

const meta = { latencyMs: 1200 } as ModelCallMeta;
const verdict = (v: Partial<Verdict> = {}): Verdict => ({
  plausible: true,
  confidence: 0.9,
  observed: "bronze spout over a stone basin",
  cue: "water",
  ...v,
});
const reader = (v: Verdict | Error) =>
  vi.fn<(input: ReaderInput) => Promise<ReadResult>>(async () => {
    if (v instanceof Error) throw v;
    return { verdict: v, meta, raw: { ...v } };
  });

describe("checkPhoto", () => {
  it("passes on GPS near even when the reader finds the photo implausible", async () => {
    const read = reader(verdict({ plausible: false, confidence: 0.95 }));
    const check = await checkPhoto({ quest, placeId: "P1", image, position: atP1 }, { env: OLLAMA, read });
    expect(check.decision).toEqual({ passed: true, by: "gps", reason: "near" });
    expect(check).toMatchObject({ verdictSource: "live", latencyMs: 1200, provider: "ollama/gemma4:e4b", retry: null });
    // At a fork the reader gets the place name and the cues of its links.
    expect(read.mock.calls[0][0]).toMatchObject({ placeName: P1.name, cues: ["writing", "water"] });
  });

  it("passes on GPS near when the reader fails", async () => {
    const check = await checkPhoto(
      { quest, placeId: "P1", image, position: atP1 },
      { env: OLLAMA, read: reader(new Error("timed out after 120000 ms")) },
    );
    expect(check.decision.passed).toBe(true);
    expect(check).toMatchObject({ verdict: null, verdictSource: null, readerError: "timed out after 120000 ms" });
    expect(verdictView(check)).toBeNull();
  });

  it("on GPS near, stops a slow reader after a short budget and still passes", async () => {
    let signal: AbortSignal | undefined;
    const read = vi.fn((_: ReaderInput, o: { signal?: AbortSignal }) => {
      signal = o.signal;
      return new Promise<ReadResult>(() => {}); // never answers
    });
    const started = Date.now();
    const check = await checkPhoto({ quest, placeId: "P1", image, position: atP1 }, { env: OLLAMA, read, nearBudgetMs: 30 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(check.decision).toEqual({ passed: true, by: "gps", reason: "near" });
    expect(check.readerError).toMatch(/GPS had already passed/);
    expect(signal?.aborted).toBe(true);
  });

  it("without GPS, gives the reader its full time (no near budget)", async () => {
    let signal: AbortSignal | undefined;
    const read = vi.fn(async (_: ReaderInput, o: { signal?: AbortSignal }) => {
      signal = o.signal;
      return { verdict: verdict(), meta, raw: { ...verdict() } };
    });
    await checkPhoto({ quest, placeId: "P1", image }, { env: OLLAMA, read, nearBudgetMs: 1 });
    expect(signal).toBeUndefined();
  });

  it("fails on GPS far without calling the reader, with a hint", async () => {
    const read = reader(verdict());
    const check = await checkPhoto({ quest, placeId: "P1", image, position: far }, { env: OLLAMA, read });
    expect(read).not.toHaveBeenCalled();
    expect(check.decision).toEqual({ passed: false, by: "gps", reason: "too-far" });
    expect(check.hint).toMatchObject({ line: { text: P1.hint.text }, direction: "S" });
    expect(check.readerCalled).toBe(false);
  });

  it("without GPS, fails an implausible photo and says what to try", async () => {
    const check = await checkPhoto(
      { quest, placeId: "P1", image, position: null },
      { env: OLLAMA, read: reader(verdict({ plausible: false, confidence: 0.9, cue: null, observed: "a laptop screen" })) },
    );
    expect(check.decision).toMatchObject({ passed: false, reason: "implausible" });
    expect(check.retry).toMatch(/outdoors/);
    expect(verdictView(check)).toMatchObject({ observed: "a laptop screen", source: "live" });
  });

  it("without GPS, passes a plausible photo at confidence ≥ 0.7", async () => {
    const check = await checkPhoto({ quest, placeId: "P1", image }, { env: OLLAMA, read: reader(verdict({ confidence: 0.7 })) });
    expect(check.decision).toEqual({ passed: true, by: "photo", reason: "plausible" });
  });

  it("uses the desk demo's stored verdict when the live reader fails", async () => {
    const stored = verdict({ observed: "a gilded inscription", cue: "writing" });
    const check = await checkPhoto(
      { quest, placeId: "P1", image, storedVerdict: stored },
      { env: OLLAMA, read: reader(new ModelCallError("HTTP 429", meta, 429)) },
    );
    expect(check).toMatchObject({ verdict: stored, verdictSource: "stored", decision: { passed: true } });
  });

  it("gives a non-fork stop no cues", async () => {
    const read = reader(verdict({ cue: null }));
    await checkPhoto({ quest, placeId: "P2", image }, { env: OLLAMA, read });
    expect(read.mock.calls[0][0].cues).toEqual([]);
  });
});

describe("chooseNext", () => {
  it("follows the cue and writes a checked bridge line", async () => {
    const model = scriptedModel([
      '{"text":"That bronze spout was built because Galata and Tophane were short of water. Another fountain waits a short walk away, on the street corner.","factIds":["F2"]}',
    ]);
    const next = await chooseNext({ quest, placeId: "P1", verdict: verdict() }, { env: OLLAMA, model, byMeaning: vi.fn() });
    expect(next.fork).toMatchObject({ chosenBy: "cue", link: { to: "P3" } });
    expect(next.bridge).toMatchObject({ source: "narrator", factIds: ["F2"] });
    expect(next.line.facts[0]).toMatchObject({ id: "F2", url: expect.stringMatching(/^https:/) });
    expect(userText(model)).toContain("bronze spout over a stone basin");
  });

  it("falls back to the link's reason when the bridge cites a fact of another link", async () => {
    const model = scriptedModel(['{"text":"That bronze spout hides a secret passage.","factIds":["F10"]}']);
    const next = await chooseNext({ quest, placeId: "P1", verdict: verdict() }, { env: OLLAMA, model, byMeaning: vi.fn() });
    const link = P1.links.find((l) => l.to === "P3")!;
    expect(next.bridge).toMatchObject({
      source: "reason",
      text: `You photographed the bronze spout over a stone basin. ${link.reason}`,
      factIds: link.factIds,
    });
    expect(next.bridge.rejected.join()).toMatch(/F10/);
  });

  it("falls back to the link's reason when the narrator call fails", async () => {
    const model = scriptedModel([new Error("connection refused")]);
    const next = await chooseNext({ quest, placeId: "P2", verdict: verdict({ cue: null }) }, { env: OLLAMA, model });
    expect(next.fork.chosenBy).toBe("only-link");
    expect(next.bridge).toMatchObject({ source: "reason", rejected: [expect.stringMatching(/connection refused/)] });
  });

  it("makes no narrator call without an observed detail", async () => {
    const model = scriptedModel(['{"text":"x","factIds":["F2"]}']);
    const bridge = await writeBridge({ quest, place: P1, link: P1.links[0], observed: null }, { env: OLLAMA, model });
    expect(bridge.source).toBe("reason");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("refuses the answer place", async () => {
    await expect(chooseNext({ quest, placeId: "P4", verdict: verdict() }, { env: OLLAMA })).rejects.toThrow(/answer place/);
  });
});
