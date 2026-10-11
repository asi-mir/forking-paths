import { describe, expect, it } from "vitest";
import {
  PEEK_GRACE_MS,
  formatDuration,
  scoreRun,
  summarize,
  type TimelineEvent,
} from "./receipt";

const s = (sec: number) => sec * 1000;
const ev = (sec: number, e: TimelineEvent["e"]) => ({ t: s(sec), e }) as TimelineEvent;

describe("summarize", () => {
  it("splits time into screen-on and pocket", () => {
    const tl = [ev(0, "visible"), ev(30, "walk"), ev(35, "hidden"), ev(335, "visible"), ev(340, "photo")];
    const r = summarize(tl, s(400));
    expect(r.screenOnMs).toBe(s(35) + s(65));
    expect(r.pocketMs).toBe(s(300));
    expect(r.totalMs).toBe(s(400));
    expect(r.peeks).toBe(0); // the unlock at 335 s was followed by a photo at 340 s
  });

  it("stops counting at the end event", () => {
    const tl = [ev(0, "visible"), ev(10, "hidden"), ev(70, "visible"), ev(80, "end")];
    const r = summarize(tl, s(999));
    expect(r.screenOnMs).toBe(s(20));
    expect(r.pocketMs).toBe(s(60));
  });

  it("counts an unlock while walking with no photo within 20 s as a peek", () => {
    const tl = [
      ev(0, "visible"),
      ev(10, "walk"),
      ev(12, "hidden"),
      ev(100, "visible"), // peek: no photo until 200 s
      ev(105, "hidden"),
      ev(200, "visible"),
      ev(210, "photo"), // not a peek
    ];
    expect(summarize(tl, s(300)).peeks).toBe(1);
  });

  it("treats a photo exactly at the edge of the window as no peek", () => {
    const tl = [ev(0, "visible"), ev(1, "walk"), ev(2, "hidden"), ev(50, "visible"), { t: s(50) + PEEK_GRACE_MS, e: "photo" as const }];
    expect(summarize(tl, s(100)).peeks).toBe(0);
  });

  it("does not count unlocks outside a walk (reading a result, the case file)", () => {
    const tl = [ev(0, "visible"), ev(5, "hidden"), ev(60, "visible"), ev(65, "walk"), ev(66, "hidden"), ev(200, "visible"), ev(205, "photo"), ev(240, "hidden"), ev(300, "visible")];
    expect(summarize(tl, s(400)).peeks).toBe(0);
  });

  it("keeps a fresh unlock pending until its 20 s window closes", () => {
    const tl = [ev(0, "visible"), ev(10, "walk"), ev(11, "hidden"), ev(100, "visible")];
    const early = summarize(tl, s(105));
    expect(early.peeks).toBe(0);
    expect(early.pendingPeek).toBe(true);
    const late = summarize(tl, s(121));
    expect(late.peeks).toBe(1);
    expect(late.pendingPeek).toBe(false);
  });

  it("counts a clue replay while walking as a peek", () => {
    const tl = [ev(0, "visible"), ev(10, "walk"), ev(11, "hidden"), ev(60, "visible"), ev(61, "replay"), ev(65, "photo")];
    // the unlock at 60 s is followed by a photo, the replay still counts
    expect(summarize(tl, s(100)).peeks).toBe(1);
  });

  it("counts an unlock followed by a replay as one peek (the real UI sequence)", () => {
    // unlock while walking, "Hear the clue again", "Lock your phone. Go.", walk on, arrive
    const tl = [
      ev(0, "visible"),
      ev(10, "walk"),
      ev(11, "hidden"),
      ev(60, "visible"),
      ev(61, "replay"),
      ev(70, "walk"),
      ev(71, "hidden"),
      ev(300, "visible"),
      ev(305, "arrive"),
      ev(310, "photo"),
    ];
    expect(summarize(tl, s(400)).peeks).toBe(1);
  });

  it("counts a replay inside a still-open 20 s window once, and clears the pending flag", () => {
    const tl = [ev(0, "visible"), ev(10, "walk"), ev(11, "hidden"), ev(60, "visible"), ev(62, "replay")];
    const early = summarize(tl, s(65));
    expect(early.peeks).toBe(1);
    expect(early.pendingPeek).toBe(false);
    expect(summarize(tl, s(200)).peeks).toBe(1);
  });

  it("counts two separate unlocks with replays as two peeks", () => {
    const tl = [
      ev(0, "visible"),
      ev(10, "walk"),
      ev(11, "hidden"),
      ev(60, "visible"),
      ev(61, "replay"),
      ev(70, "walk"),
      ev(71, "hidden"),
      ev(150, "visible"),
      ev(151, "replay"),
      ev(160, "walk"),
      ev(161, "hidden"),
    ];
    expect(summarize(tl, s(400)).peeks).toBe(2);
  });

  it("does not count the unlock at the place when I'm here follows within 20 s, however long the camera takes", () => {
    // unlock at the place, I'm here 8 s later, read the look line, camera 25 s after the unlock
    const tl = [ev(0, "visible"), ev(10, "walk"), ev(11, "hidden"), ev(300, "visible"), ev(308, "arrive"), ev(325, "photo")];
    expect(summarize(tl, s(400)).peeks).toBe(0);
  });

  it("still counts an unlock when I'm here comes later than 20 s", () => {
    const tl = [ev(0, "visible"), ev(10, "walk"), ev(11, "hidden"), ev(300, "visible"), ev(325, "arrive"), ev(330, "photo")];
    expect(summarize(tl, s(400)).peeks).toBe(1);
  });

  it("clears a pending peek when the player taps I'm here", () => {
    const tl = [ev(0, "visible"), ev(10, "walk"), ev(11, "hidden"), ev(300, "visible"), ev(305, "arrive")];
    const r = summarize(tl, s(310));
    expect(r.peeks).toBe(0);
    expect(r.pendingPeek).toBe(false);
  });

  it("ignores a replay before the walk (still on the clue screen)", () => {
    const tl = [ev(0, "visible"), ev(5, "replay"), ev(10, "walk")];
    expect(summarize(tl, s(20)).peeks).toBe(0);
  });

  it("ignores repeated states and unsorted input", () => {
    const tl = [ev(10, "hidden"), ev(0, "visible"), ev(5, "visible"), ev(20, "hidden"), ev(30, "visible")];
    const r = summarize(tl, s(40));
    expect(r.screenOnMs).toBe(s(10) + s(10));
    expect(r.pocketMs).toBe(s(20));
  });

  it("starts the clock at the first event when it is not a visibility event", () => {
    const r = summarize([ev(100, "walk"), ev(110, "hidden")], s(160));
    expect(r.screenOnMs).toBe(s(10));
    expect(r.pocketMs).toBe(s(50));
  });

  it("returns zeros for an empty timeline", () => {
    const r = summarize([], s(10));
    expect(r).toMatchObject({ screenOnMs: 0, pocketMs: 0, peeks: 0, totalMs: 0, screenOnShare: 1 });
  });

  it("survives a reload: a new visible event after a hidden gap counts the gap as pocket time", () => {
    // the tab was discarded while locked; on reload the page records "visible" again
    const tl = [ev(0, "visible"), ev(10, "walk"), ev(11, "hidden"), ev(500, "visible"), ev(505, "photo")];
    const r = summarize(tl, s(505));
    expect(r.pocketMs).toBe(s(489));
    expect(r.screenOnMs).toBe(s(16));
  });
});

describe("scoreRun", () => {
  it("gives points per stop, takes off peeks and adds the low screen-on bonus", () => {
    expect(scoreRun({ stopsFound: 3, receipt: { screenOnMs: s(60), pocketMs: s(840), peeks: 1 } })).toEqual({
      stops: 300,
      peeks: -10,
      bonus: 50,
      total: 340,
    });
  });

  it("uses the smaller bonus between 15 % and 30 % screen-on", () => {
    expect(scoreRun({ stopsFound: 4, receipt: { screenOnMs: s(25), pocketMs: s(75), peeks: 0 } }).bonus).toBe(25);
  });

  it("gives no bonus above 30 % and never goes below zero", () => {
    const r = scoreRun({ stopsFound: 0, receipt: { screenOnMs: s(50), pocketMs: s(50), peeks: 4 } });
    expect(r).toEqual({ stops: 0, peeks: -40, bonus: 0, total: 0 });
  });

  it("gives no bonus when no time was measured", () => {
    expect(scoreRun({ stopsFound: 1, receipt: { screenOnMs: 0, pocketMs: 0, peeks: 0 } }).bonus).toBe(0);
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(725_000)).toBe("12:05");
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(4_500_000)).toBe("75:00");
  });
});
