import { describe, expect, it } from "vitest";
import {
  formatDistance,
  hasFix,
  hintFor,
  hintLabel,
  MAX_ACCURACY_SLACK_M,
  PASS_CONFIDENCE,
  passRule,
  presence,
  MAX_USABLE_ACCURACY_M,
  PRESENCE_RADIUS_M,
  retryMessage,
  shouldRead,
} from "./check";
import type { Place, Verdict } from "./schema";

const place: Pick<Place, "location" | "hint"> = {
  location: { lat: 41.0, lng: 29.0 },
  hint: { text: "Look for the fountain toward the water." },
};

/** A point `metres` north of the place (1° of latitude ≈ 111,195 m). */
const north = (metres: number) => ({ lat: 41.0 + metres / 111_195, lng: 29.0 });

const verdict = (v: Partial<Verdict> = {}): Verdict => ({
  plausible: true,
  confidence: 0.9,
  observed: "carved marble panel with an inscription",
  cue: null,
  ...v,
});

describe("presence", () => {
  it("is near within 60 m with no accuracy", () => {
    const p = presence(place, north(55));
    expect(p).toMatchObject({ gps: true, near: true, radiusM: PRESENCE_RADIUS_M, accuracyM: null });
  });

  it("widens the radius by the accuracy, capped at 50 m", () => {
    expect(presence(place, { ...north(90), accuracyM: 40 })).toMatchObject({ near: true, radiusM: 100 });
    expect(presence(place, { ...north(115), accuracyM: 140 })).toMatchObject({
      near: false,
      radiusM: PRESENCE_RADIUS_M + MAX_ACCURACY_SLACK_M,
    });
  });

  it("does not use a coarse fix as GPS, and keeps its accuracy", () => {
    expect(presence(place, { ...north(900), accuracyM: 2000 })).toEqual({ gps: false, coarseAccuracyM: 2000 });
    expect(shouldRead(presence(place, { ...north(900), accuracyM: 2000 }))).toBe(true);
    expect(passRule(presence(place, { ...north(900), accuracyM: 2000 }), null).reason).not.toBe("too-far");
    expect(presence(place, { ...north(10), accuracyM: MAX_USABLE_ACCURACY_M })).toMatchObject({ gps: true, near: true });
  });

  it("is too far beyond the radius and points at the place", () => {
    const p = presence(place, north(200));
    expect(p.gps && p.near).toBe(false);
    expect(p).toMatchObject({ gps: true, direction: "S" });
    if (p.gps) expect(Math.round(p.distanceM)).toBe(200);
  });

  it("treats a missing or broken reading as no GPS", () => {
    expect(presence(place, null)).toEqual({ gps: false });
    expect(presence(place, undefined)).toEqual({ gps: false });
    expect(presence(place, { lat: Number.NaN, lng: 29 })).toEqual({ gps: false });
    expect(presence(place, { lat: 91, lng: 29 })).toEqual({ gps: false });
    expect(presence(place, { lat: 41 })).toEqual({ gps: false });
    expect(hasFix({ lat: 41, lng: 29 })).toBe(true);
  });

  it("ignores a negative or non-finite accuracy", () => {
    expect(presence(place, { ...north(10), accuracyM: -5 })).toMatchObject({ accuracyM: null, radiusM: 60 });
    expect(presence(place, { ...north(10), accuracyM: Number.POSITIVE_INFINITY })).toMatchObject({ accuracyM: null });
  });
});

describe("pass rule", () => {
  const near = presence(place, north(10));
  const far = presence(place, north(300));
  const noGps = presence(place, null);

  it("passes on GPS near, whatever the reader says", () => {
    expect(passRule(near, verdict({ plausible: false, confidence: 0.99 }))).toEqual({ passed: true, by: "gps", reason: "near" });
    expect(passRule(near, verdict({ plausible: true, confidence: 0.1 }))).toMatchObject({ passed: true });
    expect(passRule(near, null)).toMatchObject({ passed: true, reason: "near" });
  });

  it("fails on GPS far, even with a confident plausible photo", () => {
    expect(passRule(far, verdict({ confidence: 1 }))).toEqual({ passed: false, by: "gps", reason: "too-far" });
  });

  it("without GPS, passes a plausible photo at confidence ≥ 0.7", () => {
    expect(passRule(noGps, verdict({ confidence: PASS_CONFIDENCE }))).toEqual({ passed: true, by: "photo", reason: "plausible" });
    expect(passRule(noGps, verdict({ confidence: 0.69 }))).toEqual({ passed: false, by: "photo", reason: "low-confidence" });
  });

  it("without GPS, fails an implausible photo", () => {
    expect(passRule(noGps, verdict({ plausible: false, confidence: 0.95 }))).toEqual({
      passed: false,
      by: "photo",
      reason: "implausible",
    });
  });

  it("without GPS and without a verdict, fails", () => {
    expect(passRule(noGps, null)).toEqual({ passed: false, by: null, reason: "no-verdict" });
  });

  it("calls the reader only when GPS is missing or near", () => {
    expect(shouldRead(near)).toBe(true);
    expect(shouldRead(noGps)).toBe(true);
    expect(shouldRead(far)).toBe(false);
  });
});

describe("hint", () => {
  it("gives the place's hint with distance and compass direction when too far", () => {
    const p = presence(place, { lat: 41.0 - 150 / 111_195, lng: 29.0 });
    expect(hintFor(place, p)).toEqual({ line: { text: place.hint.text }, distanceM: 150, direction: "N" });
  });

  it("gives no hint when near or without GPS", () => {
    expect(hintFor(place, presence(place, north(5)))).toBeNull();
    expect(hintFor(place, presence(place, null))).toBeNull();
  });

  it("formats distances for the screen", () => {
    expect(formatDistance(0)).toBe("5 m");
    expect(formatDistance(73)).toBe("75 m");
    expect(formatDistance(123)).toBe("120 m");
    expect(formatDistance(1449)).toBe("1.4 km");
    expect(hintLabel(212, "NE")).toBe(`about 210 m north-east`);
  });

  it("has a retry message for every failing reason", () => {
    for (const reason of ["implausible", "low-confidence", "no-verdict", "too-far"] as const) {
      expect(retryMessage(reason).length).toBeGreaterThan(10);
    }
  });
});
