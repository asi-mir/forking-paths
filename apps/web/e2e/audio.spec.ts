import { expect, type Page, test } from "@playwright/test";
import { at, linesHaveText, offline, shot, takePhoto, voiceClips } from "./helpers";

/**
 * The audio rules on the street, against the real routes. Every line of the Karaköy case and the
 * three sounds are stored as short test clips in the test database (e2e/voice-clips.ts), so the
 * run starts with voice on and makes no ElevenLabs request (there is no key).
 *
 * The page's audio elements are watched from the outside: every play() and pause() is logged,
 * with the screen on show and the last tap, so no test hook lives in the app.
 *
 * - Speech starts only after a tap.
 * - The ambience plays only under the briefing and the clues.
 * - Stingers play on results.
 * - Nothing plays in pocket mode.
 * - Every line has its words on screen.
 */

test.skip(!!process.env.E2E_BASE_URL, "runs against the server Playwright starts (e2e/env.ts)");

test.beforeAll(() => voiceClips("seed"));
test.afterAll(() => voiceClips("clear")); // the other checks expect text-only lines

type MediaEvent = { t: number; op: "play" | "pause"; kind: string; muted: boolean; screen: string; lastTap: number };

/** Names the page's audio elements in the order the narrator makes them, and logs their calls. */
function watchMedia() {
  const w = window as unknown as { __media: MediaEvent[]; __els: HTMLAudioElement[]; __lastTap: number };
  w.__media = [];
  w.__els = [];
  w.__lastTap = -1;
  const kinds = ["speech", "ambience", "sfx"];
  const Orig = window.Audio;
  const Wrapped = function (this: unknown, src?: string) {
    const el = new Orig(src);
    (el as unknown as { __kind: string }).__kind = kinds[w.__els.length % 3];
    w.__els.push(el);
    return el;
  } as unknown as typeof Audio;
  Wrapped.prototype = Orig.prototype;
  window.Audio = Wrapped;
  const screen = () =>
    ["pocket", "mystery", "clue", "look", "place-name", "bridge", "too-far", "answer"].find((id) =>
      document.querySelector(`[data-testid="${id}"]`),
    ) ?? "other";
  const log = (op: "play" | "pause", el: HTMLMediaElement) =>
    w.__media.push({
      t: performance.now(),
      op,
      kind: (el as unknown as { __kind?: string }).__kind ?? "other",
      muted: el.muted,
      screen: screen(),
      lastTap: w.__lastTap,
    });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    log("play", this);
    return play.call(this);
  };
  const pause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    log("pause", this);
    return pause.call(this);
  };
  document.addEventListener("click", () => (w.__lastTap = performance.now()), true);
}

const media = (page: Page) => page.evaluate(() => (window as unknown as { __media: MediaEvent[] }).__media);
const playing = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __els: (HTMLAudioElement & { __kind: string })[] }).__els.filter((e) => !e.paused).map((e) => e.__kind),
  );
/** The audible plays (the narrator's unlock plays a silent clip, muted, inside a tap). */
const heard = async (page: Page) => (await media(page)).filter((e) => e.op === "play" && !e.muted);

test("audio: speech only after a tap, ambience only under the briefing and clues, silence in pocket mode", async ({ page, context }) => {
  test.setTimeout(90_000);
  await offline(context);
  await context.grantPermissions(["geolocation"]);
  await at(context, "P1", 150);
  await page.addInitScript(watchMedia);

  await page.goto("/?quest=demo-karakoy");
  await expect(page.getByTestId("located")).toBeVisible();
  await page.getByTestId("start").click();
  await page.waitForURL(/\/play\//, { timeout: 30_000 });

  // The briefing: voice on, every line on screen, and nothing plays before a tap on Listen.
  await expect(page.getByTestId("mystery")).toBeVisible();
  await expect(page.getByTestId("briefing-play")).toBeVisible();
  await linesHaveText(page);
  await page.waitForTimeout(1500);
  expect(await heard(page)).toEqual([]);

  await page.getByTestId("briefing-play").click();
  await expect.poll(() => playing(page)).toEqual(expect.arrayContaining(["speech", "ambience"]));
  await expect(page.getByTestId("briefing-play")).toContainText("Stop");
  await shot(page, 25, "audio-briefing-listening");

  // The clue: the narrator and the ambience again, from a tap.
  await page.getByTestId("to-clue").click();
  await expect(page.getByTestId("clue")).toBeVisible();
  await expect.poll(() => playing(page)).toEqual([]);
  await linesHaveText(page);
  await page.getByTestId("clue-play").click();
  await expect.poll(() => playing(page)).toEqual(expect.arrayContaining(["speech", "ambience"]));

  // Pocket mode: everything stops at once, and stays silent while the phone is locked.
  await page.getByTestId("go").click();
  await expect(page.getByTestId("pocket")).toBeVisible();
  expect(await playing(page)).toEqual([]);
  const pocketFrom = (await media(page)).length;
  await page.waitForTimeout(1500);
  expect(await playing(page)).toEqual([]);
  expect((await media(page)).slice(pocketFrom).filter((e) => e.op === "play")).toEqual([]);

  // At the place: the look line, a photo, a stinger on the result, the reveal without ambience.
  await at(context, "P1");
  await page.getByTestId("im-here").click();
  await expect(page.getByTestId("look")).toBeVisible();
  await linesHaveText(page);
  await takePhoto(page);
  await expect(page.getByTestId("place-name")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await heard(page)).some((e) => e.kind === "sfx")).toBe(true);
  await linesHaveText(page);
  await page.getByTestId("reveal-play").click();
  await expect.poll(() => playing(page)).toContain("speech");
  await page.waitForTimeout(400);
  expect(await playing(page)).not.toContain("ambience");
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("bridge")).toBeVisible();
  await linesHaveText(page);

  const all = await heard(page);
  const speech = all.filter((e) => e.kind === "speech");
  expect(speech.length).toBe(3); // briefing, clue, reveal: each one tapped
  for (const e of speech) expect(e.t - e.lastTap).toBeLessThan(2000);
  const ambience = all.filter((e) => e.kind === "ambience");
  expect(ambience.length).toBe(2);
  for (const e of ambience) expect(["mystery", "clue"]).toContain(e.screen);
  expect(all.filter((e) => e.screen === "pocket")).toEqual([]);
});
