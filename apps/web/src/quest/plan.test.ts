import { describe, expect, it } from "vitest";
import { distanceM } from "@/lib/geo";
import { fourStop, threeStop } from "./__fixtures__";
import { describeOption, maxRouteM, routeOptions } from "./plan";
import { LIMITS, routeLengthM } from "./validate";

describe("routeOptions", () => {
  it("finds 3-stop options whose hops are all ≤ 250 m and whose longest route fits 15 minutes", () => {
    const fx = threeStop();
    const options = routeOptions(fx.candidates, fx.opts.center, 15);
    expect(options.length).toBeGreaterThan(0);
    const loc = new Map(fx.candidates.map((c) => [c.id, c.location]));
    for (const o of options) {
      expect(o.stopsPerRun).toBe(3);
      expect(new Set(o.places).size).toBe(4);
      expect(distanceM(fx.opts.center, loc.get(o.start)!)).toBeLessThanOrEqual(LIMITS.maxHopM);
      for (const mid of o.firstFork) {
        expect(distanceM(loc.get(o.start)!, loc.get(mid)!)).toBeLessThanOrEqual(LIMITS.maxHopM);
        expect(distanceM(loc.get(mid)!, loc.get(o.answer)!)).toBeLessThanOrEqual(LIMITS.maxHopM);
        const m = routeLengthM(fx.opts.center, [o.start, mid, o.answer].map((id) => loc.get(id)!));
        expect(m).toBeLessThanOrEqual(maxRouteM(15, 3));
      }
    }
    // P5 is ~1 km away: never part of an option.
    expect(options.some((o) => o.places.includes("P5"))).toBe(false);
  });

  it("finds 4-stop options with two forks that meet again at the answer", () => {
    const fx = fourStop();
    const options = routeOptions(fx.candidates, fx.opts.center, 25);
    expect(options.length).toBeGreaterThan(0);
    const loc = new Map(fx.candidates.map((c) => [c.id, c.location]));
    for (const o of options) {
      expect(o.stopsPerRun).toBe(4);
      expect(o.secondFork).toHaveLength(2);
      expect(new Set(o.places).size).toBe(6);
      for (const a of o.firstFork) {
        for (const c of o.secondFork!) {
          expect(distanceM(loc.get(a)!, loc.get(c)!)).toBeLessThanOrEqual(LIMITS.maxHopM);
          expect(distanceM(loc.get(c)!, loc.get(o.answer)!)).toBeLessThanOrEqual(LIMITS.maxHopM);
        }
      }
    }
  });

  it("returns nothing when the places are too far apart", () => {
    const fx = threeStop();
    const spread = fx.candidates.map((c, i) => ({ ...c, location: { lat: c.location.lat + i * 0.01, lng: c.location.lng } }));
    expect(routeOptions(spread, fx.opts.center, 15)).toEqual([]);
  });

  it("keeps at most `limit` options, at most two per answer place", () => {
    const fx = fourStop();
    const options = routeOptions(fx.candidates, fx.opts.center, 25, { limit: 3 });
    expect(options.length).toBeLessThanOrEqual(3);
    const perAnswer = new Map<string, number>();
    for (const o of options) perAnswer.set(o.answer, (perAnswer.get(o.answer) ?? 0) + 1);
    for (const n of perAnswer.values()) expect(n).toBeLessThanOrEqual(2);
  });

  it("spells out every place and link of an option", () => {
    const fx = fourStop();
    const [o] = routeOptions(fx.candidates, fx.opts.center, 25);
    const text = describeOption(o, 0);
    expect(text).toContain(`${o.start}: start, a fork with 2 links`);
    expect(text).toContain(`${o.answer}: the answer place, no links`);
    expect(text.split("\n")).toHaveLength(7);
  });
});
