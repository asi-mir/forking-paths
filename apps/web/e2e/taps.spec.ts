import { expect, type Page, test } from "@playwright/test";
import { deniedPhone, smallTapTargets } from "./helpers";

/**
 * Every tap target on every desk-demo screen is at least 44 x 44 px on a phone (390 x 844), and
 * nothing is wider than the screen. Links inside a sentence (photo credits) are exempt.
 */

test.skip(!!process.env.E2E_BASE_URL, "runs against the server Playwright starts (e2e/env.ts)");

async function screenOk(page: Page, name: string) {
  expect(await smallTapTargets(page), `small tap targets on ${name}`).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} is wider than the phone`).toBeLessThanOrEqual(390);
}

test("tap targets are 44 px or more, and no screen scrolls sideways", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await deniedPhone(browser);
  const page = await context.newPage();
  await page.goto("/");
  await page.getByTestId("locate").click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByTestId("location-denied")).toBeVisible();
  await screenOk(page, "the start page");

  await page.goto("/demo/near");
  await screenOk(page, "the city picker");
  await page.getByTestId("city-istanbul").click();
  await expect(page.getByTestId("quest-preview")).toBeVisible({ timeout: 30_000 });
  await screenOk(page, "the case preview");

  await page.goto("/demo");
  await expect(page.getByTestId("desk-intro")).toBeVisible();
  await screenOk(page, "the desk demo");
  await page.getByTestId("desk-start").click();
  await page.waitForURL(/\/play\//, { timeout: 30_000 });
  await expect(page.getByTestId("mystery")).toBeVisible();
  await screenOk(page, "the briefing");
  await page.getByTestId("to-clue").click();
  await screenOk(page, "the clue");

  const stop = async (sample: string, name: string) => {
    await page.getByTestId("desk-arrive").click();
    await expect(page.getByTestId("sample-picker")).toBeVisible();
    await screenOk(page, `the look screen at ${name}`);
    await page.getByTestId(`sample-${sample}`).click();
    await expect(page.getByTestId("place-name")).toBeVisible({ timeout: 30_000 });
    await screenOk(page, `the result at ${name}`);
    await page.getByTestId("after-result").click();
  };
  await stop("p1-water", "the fork");
  await expect(page.getByTestId("bridge")).toBeVisible();
  await screenOk(page, "the bridge");
  await page.getByTestId("to-next-clue").click();
  await stop("p3-inscription", "stop 2");
  await page.getByTestId("to-next-clue").click();
  await stop("p4-stairs", "the answer");
  await expect(page.getByTestId("answer")).toBeVisible();
  await screenOk(page, "the finale");
  await page.getByTestId("open-case-file").click();
  await page.waitForURL(/\/end\//);
  await expect(page.getByTestId("receipt")).toBeVisible();
  await screenOk(page, "the case file");
  await context.close();
});
