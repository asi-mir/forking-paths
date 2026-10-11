import { describe, expect, it } from "vitest";
import { ambienceUnder, lineKind, stingerFor } from "./audio-mix";

describe("audio mix rules", () => {
  it("plays the ambience under the briefing and the clues only", () => {
    expect(ambienceUnder(lineKind("briefing"))).toBe(true);
    expect(ambienceUnder(lineKind("p1.clue"))).toBe(true);
    for (const key of ["p1.look", "p1.hint", "p1.reveal", "finale", "bridge"] as const) {
      expect(ambienceUnder(lineKind(key))).toBe(false);
    }
  });

  it("reads the part from a place id that has dots in it", () => {
    expect(lineKind("place.with.dots.reveal")).toBe("reveal");
    expect(() => lineKind("p1.walk" as never)).toThrow();
  });

  it("picks the stinger from the result", () => {
    expect(stingerFor({ passed: true })).toBe("found");
    expect(stingerFor({ passed: false })).toBe("notHere");
  });
});
