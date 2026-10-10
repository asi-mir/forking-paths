import { expect, test } from "@playwright/test";
import { deleteQuest, deniedPhone, offline, questCount, shot } from "./helpers";

/**
 * The start page and "Generate a quest near me". The server runs with today's quest cap at 0 and
 * no voice key (e2e/env.ts): a saved quest within ~500 m is reused, past that the nearest saved
 * quest within ~3 km is offered, and lines show as text. No quest is ever generated here.
 */

test.skip(!!process.env.E2E_BASE_URL, "runs against the server Playwright starts (e2e/env.ts)");

const KARAKOY = { latitude: 41.0247, longitude: 28.9744 };
const north = (m: number) => ({ latitude: KARAKOY.latitude + m / 111_195, longitude: KARAKOY.longitude, accuracy: 10 });

test("the start page before location is asked", async ({ page, context }) => {
  await offline(context);
  await page.goto("/");
  await expect(page.getByTestId("locate")).toBeVisible();
  await expect(page.getByTestId("start")).toBeDisabled();
  await expect(page.getByTestId("desk-demo")).toBeVisible();
  await shot(page, 1, "start");
});

test("location denied: the start page offers the desk demo and a city picker", async ({ browser }) => {
  const context = await deniedPhone(browser);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByTestId("locate").click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByTestId("location-denied")).toBeVisible();
  await expect(page.getByTestId("start")).toBeDisabled();
  await expect(page.getByTestId("desk-demo")).toHaveAttribute("href", "/demo");
  await expect(page.getByTestId("desk-demo")).toContainText("Try it from your desk");
  await expect(page.getByTestId("pick-city")).toHaveAttribute("href", "/demo/near");
  await shot(page, 2, "start-location-denied");
  await page.getByTestId("pick-city").click();
  await page.waitForURL(/\/demo\/near/);
  await page.getByTestId("near-locate").click();
  await expect(page.getByTestId("near-denied")).toBeVisible();
  await expect(page.getByTestId("city-istanbul")).toContainText("tested");
  await shot(page, 50, "near-denied-city-picker");
  // Istanbul is the saved Karaköy case: reused, nothing generated.
  await page.getByTestId("city-istanbul").click();
  await expect(page.getByTestId("quest-preview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("quest-preview")).toContainText("A saved case");
  await context.close();
});

test("generate near me reuses a saved quest within ~500 m, even on an empty database", async ({ page, context }) => {
  await offline(context);
  await deleteQuest("demo-karakoy"); // the case is saved by the first request, not by a run
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(north(300));
  await page.goto("/demo/near");
  await page.getByTestId("near-locate").click();
  await expect(page.getByTestId("quest-preview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("quest-preview")).toContainText("A saved case");
  await expect(page.getByTestId("preview-title")).toHaveText("The Secret of the Braided Stairs");
  // Every way on, every fact with its link.
  await expect(page.getByTestId("preview-link")).toHaveCount(4);
  const facts = page.getByTestId("preview-facts").getByTestId("fact");
  expect(await facts.count()).toBeGreaterThan(3);
  for (const fact of await facts.all()) await expect(fact.locator("a[href^='https://']")).toHaveCount(1);
  expect(await questCount()).toBe(1);
  await shot(page, 51, "near-reused-preview");
});

test("over the daily cap: the nearest saved case is offered, and lines show as text", async ({ page, context }) => {
  await offline(context);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(north(1500)); // past the reuse radius, inside the ~3 km offer
  await page.goto("/demo/near");
  await page.getByTestId("near-locate").click();
  await expect(page.getByTestId("quest-preview")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("quest-preview")).toContainText("Nearest saved case (today's limit reached)");
  await page.getByTestId("play-briefing").click();
  await expect(page.getByTestId("line-text-only").first()).toContainText(/shows? as text/);
  await shot(page, 52, "near-over-cap-text-only");
  expect(await questCount()).toBe(1);

  // On the street, the same: the nearest saved case starts, text only.
  await page.goto("/");
  await expect(page.getByTestId("located")).toBeVisible();
  await page.getByTestId("start").click();
  await expect(page.getByTestId("start-log")).toContainText("Today's limit for new cases is reached");
  await page.waitForURL(/\/play\//, { timeout: 30_000 });
  await expect(page.getByTestId("mystery")).toBeVisible();
  await expect(page.getByText("Text only").first()).toBeVisible();
});

test("over the daily cap far from any saved case: no quest, the desk demo instead", async ({ page, context }) => {
  await offline(context);
  await page.goto("/demo/near");
  await page.getByTestId("city-rome").click();
  await expect(page.getByText("no saved quest is near here")).toContainText("Try the desk demo");
  await expect(page.getByTestId("near-desk-demo")).toHaveAttribute("href", "/demo");
  await shot(page, 53, "near-over-cap-no-case");
  expect(await questCount()).toBe(1);
});
