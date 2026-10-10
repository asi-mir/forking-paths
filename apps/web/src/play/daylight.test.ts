import { describe, expect, it } from "vitest";
import { isDark, sunElevation } from "./daylight";

const KARAKOY = { lat: 41.0247, lng: 28.9744 };

describe("daylight", () => {
  it("is light at midday and dark late in the evening in Karaköy", () => {
    expect(isDark(KARAKOY.lat, KARAKOY.lng, new Date("2026-10-10T12:00:00+03:00"))).toBe(false);
    expect(isDark(KARAKOY.lat, KARAKOY.lng, new Date("2026-10-10T21:36:00+03:00"))).toBe(true);
    expect(isDark(KARAKOY.lat, KARAKOY.lng, new Date("2026-10-11T04:00:00+03:00"))).toBe(true);
  });

  it("puts sunset in Istanbul on 10 October between 18:30 and 18:55 local time", () => {
    // Sunset in Istanbul that day falls between these two times.
    expect(sunElevation(KARAKOY.lat, KARAKOY.lng, new Date("2026-10-10T18:30:00+03:00"))).toBeGreaterThan(-0.833);
    expect(sunElevation(KARAKOY.lat, KARAKOY.lng, new Date("2026-10-10T18:55:00+03:00"))).toBeLessThan(-0.833);
  });
});
