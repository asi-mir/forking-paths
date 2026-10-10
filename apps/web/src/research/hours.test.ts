import { describe, expect, it } from "vitest";
import { closedForGood, localClock, openAt, openForWalk, parseDayHours, parseWeek } from "./hours";

const IST = "Europe/Istanbul"; // UTC+3 all year

describe("parseDayHours", () => {
  it("reads Google's day strings, with the narrow spaces it puts before AM/PM", () => {
    expect(parseDayHours("8:30 AM–10 PM")).toEqual([[510, 1320]]);
    expect(parseDayHours("Open 24 hours")).toBe("open24");
    expect(parseDayHours("Closed")).toBe("closed");
    expect(parseDayHours("8 AM–12 PM, 1–5 PM")).toEqual([
      [480, 720],
      [780, 1020],
    ]);
    expect(parseDayHours("11–2 PM")).toEqual([[660, 840]]); // 11 AM, not 11 PM
    expect(parseDayHours("09:00–19:00")).toEqual([[540, 1140]]);
    expect(parseDayHours("Kapalı")).toBe("closed");
    expect(parseDayHours("sometimes")).toBeNull();
  });
});

describe("openAt", () => {
  const week = parseWeek({
    friday: "6 PM–2 AM",
    saturday: "Closed",
    sunday: "9 AM–5 PM",
    monday: "Open 24 hours",
  })!;

  it("handles ranges past midnight and closed days", () => {
    expect(openAt(week, { weekday: 5, minutes: 19 * 60 })).toBe(true); // Fri 19:00
    expect(openAt(week, { weekday: 6, minutes: 60 })).toBe(true); // Sat 01:00, Friday's night
    expect(openAt(week, { weekday: 6, minutes: 3 * 60 })).toBe(false); // Sat 03:00
    expect(openAt(week, { weekday: 0, minutes: 8 * 60 })).toBe(false); // Sun 08:00
    expect(openAt(week, { weekday: 1, minutes: 4 * 60 })).toBe(true);
    expect(openAt(week, { weekday: 3, minutes: 600 })).toBeUndefined(); // Wednesday not listed
  });
});

describe("openForWalk", () => {
  const garden = { operatingHours: { saturday: "9 AM–6 PM", sunday: "9 AM–6 PM" } };

  it("uses the player's time zone, and needs the place open for the whole walk", () => {
    // Saturday 17:00 in Istanbul (14:00 UTC).
    expect(localClock(new Date("2026-10-10T14:00:00Z"), IST)).toEqual({ weekday: 6, minutes: 17 * 60 });
    expect(openForWalk(garden, new Date("2026-10-10T14:00:00Z"), 25, IST)).toBe(true);
    // 17:40 + 25 min ends after closing.
    expect(openForWalk(garden, new Date("2026-10-10T14:40:00Z"), 25, IST)).toBe(false);
    expect(openForWalk(garden, new Date("2026-10-10T03:00:00Z"), 25, IST)).toBe(false);
  });

  it("is unknown without hours or a time zone, and closed when closed for good", () => {
    expect(openForWalk({}, new Date(), 25, IST)).toBeUndefined();
    expect(openForWalk(garden, new Date(), 25, undefined)).toBeUndefined();
    expect(openForWalk(garden, new Date(), 25, "Not/AZone")).toBeUndefined();
    expect(openForWalk({ openState: "Permanently closed" }, new Date(), 25, undefined)).toBe(false);
    expect(closedForGood("Closed · Opens 9 AM Mon")).toBe(false);
  });
});
