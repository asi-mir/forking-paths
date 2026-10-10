import { describe, expect, it } from "vitest";
import {
  bearingDeg,
  COMPASS_NAMES,
  compass8,
  compassDirection,
  distanceM,
  isNear,
  walkMinutes,
} from "./geo";

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

describe("bearingDeg and compass8", () => {
  const origin = { lat: 41.0, lng: 29.0 };

  it("points north, east, south and west", () => {
    expect(bearingDeg(origin, { lat: 41.01, lng: 29.0 })).toBeCloseTo(0, 0);
    expect(bearingDeg(origin, { lat: 41.0, lng: 29.01 })).toBeCloseTo(90, 0);
    expect(bearingDeg(origin, { lat: 40.99, lng: 29.0 })).toBeCloseTo(180, 0);
    expect(bearingDeg(origin, { lat: 41.0, lng: 28.99 })).toBeCloseTo(270, 0);
  });

  it("names the 8 sectors, wrapping at 360", () => {
    expect(compass8(0)).toBe("N");
    expect(compass8(22)).toBe("N");
    expect(compass8(23)).toBe("NE");
    expect(compass8(135)).toBe("SE");
    expect(compass8(225)).toBe("SW");
    expect(compass8(337.6)).toBe("N");
    expect(compass8(-45)).toBe("NW");
    expect(COMPASS_NAMES[compass8(45)]).toBe("north-east");
  });

  it("gives the direction from Karaköy pier up to Galata Tower", () => {
    expect(compassDirection(karakoy, galata)).toBe("NW");
  });
});

describe("walkMinutes", () => {
  it("adds 70 m/min walking and 2 min per stop", () => {
    expect(walkMinutes(700, 3)).toBe(16);
    expect(walkMinutes(0, 4)).toBe(8);
  });
});
