import { describe, expect, it } from "vitest";
import { distanceM, isNear } from "./geo";

// Galata Tower and Karaköy pier, Istanbul: about 600 m apart.
const galata = { lat: 41.025631, lng: 28.974155 };
const karakoy = { lat: 41.02163, lng: 28.97741 };

describe("distanceM", () => {
  it("is zero for the same point", () => {
    expect(distanceM(galata, galata)).toBe(0);
  });

  it("measures a known short city distance", () => {
    const d = distanceM(galata, karakoy);
    expect(d).toBeGreaterThan(450);
    expect(d).toBeLessThan(650);
  });
});

describe("isNear", () => {
  it("accepts a player inside the radius", () => {
    expect(isNear({ lat: 41.0257, lng: 28.9742 }, galata)).toBe(true);
  });

  it("rejects a player far away even with poor accuracy", () => {
    expect(isNear({ ...karakoy, accuracyM: 500 }, galata)).toBe(false);
  });
});
