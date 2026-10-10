import { describe, expect, it } from "vitest";
import type { PhotoResult, StartRunResponse } from "@/quest/api";
import { applyResult, newRun, sampleSent } from "./run-state";

const start = {
  runId: "r1",
  questId: "demo-karakoy",
  title: "T",
  mystery: "Q?",
  briefing: { text: "b" },
  first: { placeId: "P1", stop: 1, of: 3, isFork: true, clue: { text: "c" }, look: { text: "l" } },
  preload: [],
  stingers: {},
  voice: false,
} satisfies StartRunResponse;

describe("desk demo run state", () => {
  it("marks a desk run and remembers the sample sent at each stop", () => {
    const s = newRun(start, false, 0, { desk: true });
    expect(s.desk).toBe(true);
    const sent = sampleSent(s, "P1", "p1-water");
    expect(sent.samples).toEqual({ P1: "p1-water" });
    expect(sampleSent(sent, "P1", null).samples).toEqual({}); // the visitor's own photo: no credit
    expect(newRun(start, false, 0).desk).toBeUndefined();
  });

  it("keeps the cue that picked the way at a fork for the route so far", () => {
    const result = {
      status: "passed",
      placeId: "P1",
      name: "Fountain",
      verdict: { observed: "a brass spout", cue: "water", plausible: true, confidence: 0.95, source: "stored" },
      reveal: { line: { text: "r" }, facts: [] },
      next: {
        bridge: { line: { text: "b" }, facts: [] },
        chosenBy: "cue",
        stop: { placeId: "P3", stop: 2, of: 3, isFork: false, clue: { text: "c" }, look: { text: "l" } },
      },
      end: null,
    } satisfies PhotoResult;
    const s = applyResult(newRun(start, false, 0, { desk: true }), result);
    expect(s.passed).toEqual([{ placeId: "P1", name: "Fountain", status: "passed", cue: "water", next: "P3" }]);
  });
});
