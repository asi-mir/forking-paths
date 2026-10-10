import { describe, expect, it } from "vitest";
import { createMockApi } from "@/play/mock";
import { applyResult, newRun } from "@/play/run-state";
import { PhotoResultSchema, StartRunResponseSchema, type PhotoResult } from "./api";
import { addChecker, checkerFromLabel, checkerLabel, gemmaName, viewOfVerdict } from "./checker";

const verdict = { plausible: true, confidence: 0.9, observed: "carved marble panel", cue: null };

describe("gemmaName", () => {
  it("names Gemma 4 sizes in plain words", () => {
    expect(gemmaName("gemma-4-26b-a4b-it")).toBe("Gemma 4 26B");
    expect(gemmaName("gemma-4-31b-it")).toBe("Gemma 4 31B");
    expect(gemmaName("gemma4:e4b")).toBe("Gemma 4 E4B");
    expect(gemmaName("gemma4:12b")).toBe("Gemma 4 12B");
    expect(gemmaName("gemma4:e4b-it-q8_0")).toBe("Gemma 4 E4B");
    expect(gemmaName("gemma4:latest")).toBe("Gemma 4");
    expect(gemmaName("my-finetune:1")).toBe("my-finetune:1");
  });
});

describe("checkerLabel", () => {
  it("says where the photo check ran, in the receipt's words", () => {
    expect(checkerLabel({ provider: "ollama", model: "gemma4:e4b" })).toBe("Gemma 4 E4B on my laptop (Ollama)");
    expect(checkerLabel({ provider: "google", model: "gemma-4-26b-a4b-it" })).toBe("Gemma 4 26B on Google AI Studio");
  });
});

describe("checkerFromLabel", () => {
  it("reads the attempt's model label", () => {
    expect(checkerFromLabel("ollama/gemma4:e4b")).toEqual({ provider: "ollama", model: "gemma4:e4b" });
    expect(checkerFromLabel("google/gemma-4-26b-a4b-it")).toEqual({ provider: "google", model: "gemma-4-26b-a4b-it" });
    expect(checkerFromLabel(null)).toBeNull();
    expect(checkerFromLabel("mock/x")).toBeNull();
    expect(checkerFromLabel("ollama/")).toBeNull();
    expect(checkerFromLabel("gemma4:e4b")).toBeNull();
  });
});

describe("viewOfVerdict", () => {
  it("names the checker on a live verdict only", () => {
    expect(viewOfVerdict(verdict, "live", "ollama/gemma4:e4b")).toEqual({
      ...verdict,
      source: "live",
      checkedBy: { provider: "ollama", model: "gemma4:e4b" },
    });
    expect(viewOfVerdict(verdict, "stored", "google/gemma-4-26b-a4b-it")).toEqual({ ...verdict, source: "stored" });
    expect(viewOfVerdict(verdict, "live", null)).toEqual({ ...verdict, source: "live" });
  });
});

describe("addChecker", () => {
  it("keeps each checker once, in order", () => {
    const a = { provider: "ollama", model: "gemma4:e4b" } as const;
    const b = { provider: "google", model: "gemma-4-26b-a4b-it" } as const;
    expect(addChecker(addChecker(addChecker([], a), a), b)).toEqual([a, b]);
    expect(addChecker([a], null)).toEqual([a]);
  });
});

describe("the phone's run record", () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }

  it("collects which Gemma read the walk's photos, for the receipt", async () => {
    const api = createMockApi({ storage: memory(), delayMs: 0, controls: () => ({}), newId: () => "chk01" });
    const quest = await api.createQuest({ lat: 41.026, lng: 28.975, minutes: 15, lang: "en" });
    const start = StartRunResponseSchema.parse(await api.startRun({ questId: quest.questId }));
    let s = newRun(start, true, 0);
    expect(s.checkers).toEqual([]);

    const local = { provider: "ollama", model: "gemma4:e4b" } as const;
    const withChecker = (r: PhotoResult): PhotoResult =>
      PhotoResultSchema.parse("verdict" in r && r.verdict ? { ...r, verdict: { ...r.verdict, checkedBy: local } } : r);
    const r1 = await api.sendPhoto(start.runId, new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }), {
      placeId: start.first.placeId,
      lat: 41.026,
      lng: 28.975,
      accuracy: 10,
    });
    s = applyResult(s, withChecker(r1));
    s = applyResult(s, withChecker(r1));
    expect(s.checkers).toEqual([local]);

    // A record saved before checkers existed still takes results.
    const old = { ...s, checkers: undefined };
    expect(applyResult(old, withChecker(r1)).checkers).toEqual([local]);
  });
});
