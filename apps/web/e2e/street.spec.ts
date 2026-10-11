import { expect, test } from "@playwright/test";
import { at, attemptsOf, offline, PLACES, type PlaceId, runIdOf, scrollToTestId, setHidden, shot, smallTapTargets, takePhoto } from "./helpers";

/**
 * Street play of the Karaköy case on a phone, with the phone's position set to each stop. The
 * photo reader is off in the checks (e2e/env.ts), so every stop passes on GPS alone, as a stop
 * must when the reader is slow or down. Time in the page runs on Playwright's clock, so the
 * screen-time receipt can be checked to the second without waiting.
 */

test.skip(!!process.env.E2E_BASE_URL, "runs against the server Playwright starts (e2e/env.ts)");

test("street play: GPS passes each stop, too far gives the hint with no model call, lock and reload keep the walk", async ({ page, context }) => {
  test.setTimeout(120_000);
  await offline(context);
  await context.grantPermissions(["geolocation"]);
  await at(context, "P1", 150); // a short walk from the first stop
  await page.clock.install();

  // Start: the saved Karaköy case, located.
  await page.goto("/?quest=demo-karakoy");
  await expect(page.getByTestId("located")).toBeVisible();
  await shot(page, 10, "street-start-located");
  await page.getByTestId("start").click();
  await page.waitForURL(/\/play\//, { timeout: 30_000 });
  const runId = runIdOf(page);

  // Briefing and the first clue: every line is on screen.
  await expect(page.getByTestId("mystery")).toBeVisible();
  await expect(page.getByTestId("safety")).toContainText("Stay on the pavement, daylight only.");
  await shot(page, 11, "street-briefing");
  await page.getByTestId("to-clue").click();
  await expect(page.getByTestId("clue")).toBeVisible();
  await shot(page, 12, "street-clue");

  // Pocket mode: lock 60 s, a peek of 25 s, lock again 30 s.
  await page.getByTestId("go").click();
  await expect(page.getByTestId("pocket")).toContainText("Lock your phone. Go.");
  await shot(page, 13, "street-pocket");
  expect(await smallTapTargets(page)).toEqual([]);
  await page.clock.runFor(2_000);
  await setHidden(page, true);
  await page.clock.runFor(60_000);
  await setHidden(page, false); // unlocked on the way, no "I'm here" within 20 s: a peek
  await page.clock.runFor(25_000);
  await setHidden(page, true);
  await page.clock.runFor(30_000);

  // A reload mid-walk keeps the walk (and the page comes back visible).
  await page.reload();
  await expect(page.getByTestId("pocket")).toBeVisible();
  await page.clock.runFor(1_000);

  // Stop 1, the fork, at the place: GPS alone passes (the reader does not answer).
  await at(context, "P1");
  await page.getByTestId("im-here").click();
  await expect(page.getByTestId("fork-note")).toBeVisible();
  await expect(page.getByTestId("gps")).toContainText("±8 m");
  await shot(page, 14, "street-look-fork");
  expect(await smallTapTargets(page)).toEqual([]);
  await takePhoto(page);
  await expect(page.getByTestId("place-name")).toHaveText(PLACES.P1.name, { timeout: 30_000 });
  await expect(page.getByTestId("observed")).toContainText("GPS put you here");
  await shot(page, 15, "street-result-gps-only");
  let attempts = await attemptsOf(runId);
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ placeId: "P1", passed: true, verdict: null });
  expect(attempts[0].distanceM).toBeLessThan(25);

  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("bridge")).toBeVisible();
  await expect(page.getByTestId("fork-fallback")).toContainText("nearest");
  await shot(page, 16, "street-fork-bridge-nearest");
  await page.getByTestId("to-next-clue").click();
  await expect(page.getByTestId("clue")).toBeVisible();

  // Stop 2: 400 m off first. The hint, the distance and the direction; the reader is not called.
  await page.getByTestId("go").click();
  const before = (await attemptsOf(runId)).length;
  // Which stop is next: the walk record on the phone knows.
  const next = (await page.evaluate((id) => {
    const run = JSON.parse(localStorage.getItem(`fp:run:${id}`) ?? "{}") as { stop?: { placeId?: string } };
    return run.stop?.placeId ?? "";
  }, runId)) as PlaceId;
  expect(["P2", "P3"]).toContain(next);
  await at(context, next, 400);
  await page.getByTestId("im-here").click();
  await takePhoto(page);
  await expect(page.getByTestId("too-far")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("distance")).toHaveText(/^(3[5-9]\d|4[0-4]\d) m$/);
  await expect(page.getByTestId("too-far")).toContainText("to the south");
  await expect(page.getByTestId("hint")).toBeVisible();
  await shot(page, 17, "street-too-far");
  expect(await smallTapTargets(page)).toEqual([]);
  attempts = await attemptsOf(runId);
  expect(attempts).toHaveLength(before + 1);
  expect(attempts.at(-1)).toMatchObject({ placeId: next, passed: false, verdict: null, provider: null });

  // Check again from the place: found.
  await at(context, next);
  await page.getByTestId("check-again").click();
  await takePhoto(page);
  await expect(page.getByTestId("place-name")).toHaveText(PLACES[next].name, { timeout: 30_000 });
  await page.getByTestId("after-result").click();
  await page.getByTestId("to-next-clue").click();

  // Stop 3, the answer.
  await page.getByTestId("go").click();
  await at(context, "P4");
  await page.getByTestId("im-here").click();
  await takePhoto(page);
  await expect(page.getByTestId("place-name")).toHaveText(PLACES.P4.name, { timeout: 30_000 });
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("answer")).toBeVisible();
  await shot(page, 18, "street-finale");
  await page.getByTestId("open-case-file").click();
  await page.waitForURL(/\/end\//);

  // The case file: the route walked, the road not taken, the receipt.
  const other = next === "P2" ? "P3" : "P2";
  await expect(page.getByTestId("route").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("route")).toContainText(PLACES[next].name);
  await expect(page.getByTestId("not-taken")).toContainText(PLACES[other].name);
  await expect(page.getByTestId("photos").locator("img")).toHaveCount(3);
  // Locked 60 s + 30 s; one peek (the 25 s unlock); the reload is not a peek.
  await expect(page.getByTestId("peeks")).toHaveText("1");
  await expect(page.getByTestId("receipt").getByTestId("pocket")).toHaveText(/^1:3[0-4] · \d+%$/); // plus the real seconds the reload took
  await shot(page, 19, "street-case-file");
  await scrollToTestId(page, "route", 90);
  await shot(page, 20, "street-case-route");
  await scrollToTestId(page, "receipt", 60);
  await shot(page, 21, "street-receipt");
});
