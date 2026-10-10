import { expect, type Page, test } from "@playwright/test";
import { deniedPhone, PLACES, scrollToTestId, shot } from "./helpers";

/**
 * The desk demo ("Try it from your desk") with location denied: the Karaköy case with the sample
 * photos. The reader is off in the checks, so each sample photo uses its stored result, labelled
 * on screen. Each fork photo leads to a different next stop, and every way ends at the answer.
 */

test.skip(!!process.env.E2E_BASE_URL, "runs against the server Playwright starts (e2e/env.ts)");

async function begin(page: Page, n?: number) {
  await page.goto("/demo");
  await expect(page.getByTestId("desk-intro")).toBeVisible();
  if (n) await shot(page, n, "desk-intro");
  await page.getByTestId("desk-start").click();
  await page.waitForURL(/\/play\//, { timeout: 30_000 });
  await expect(page.getByTestId("mystery")).toBeVisible();
  if (n) await shot(page, n + 1, "desk-briefing");
  await page.getByTestId("to-clue").click();
  await expect(page.getByTestId("clue")).toBeVisible();
}

/** From a clue screen: skip the walk and send a sample photo; returns the revealed place name. */
async function sample(page: Page, id: string) {
  await page.getByTestId("desk-arrive").click();
  await expect(page.getByTestId("sample-picker")).toBeVisible();
  await page.getByTestId(`sample-${id}`).click();
  await expect(page.getByTestId("place-name")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("stored-note")).toContainText("Stored result");
  return page.getByTestId("place-name").innerText();
}

const WAYS = [
  { cue: "writing", photo: "p1-writing", next: "P2", nextPhoto: "p2-plaque", other: "the water, you would have gone to Hasan Ağa Fountain" },
  { cue: "water", photo: "p1-water", next: "P3", nextPhoto: "p3-inscription", other: "the writing, you would have gone to Bereketzade Ali Efendi Mosque" },
] as const;

for (const way of WAYS) {
  test(`desk demo, the ${way.cue} way: the fork photo picks the next stop, the case file shows the road not taken`, async ({ browser }) => {
    test.setTimeout(120_000);
    const first = way.cue === "writing";
    const context = await deniedPhone(browser);
    const page = await context.newPage();
    await begin(page, first ? 30 : undefined);
    if (first) await shot(page, 32, "desk-clue");

    // The fork: two sample photos, credited, and "use your own photo".
    await page.getByTestId("desk-arrive").click();
    await expect(page.getByTestId("fork-note")).toBeVisible();
    await expect(page.getByTestId("sample-p1-writing")).toBeVisible();
    await expect(page.getByTestId("sample-p1-water")).toBeVisible();
    await expect(page.getByTestId("sample-credit").first()).toContainText("Wikimedia Commons");
    await expect(page.getByTestId("own-photo")).toBeAttached();
    if (first) {
      await shot(page, 33, "desk-fork-samples");
      await scrollToTestId(page, "sample-picker", 60);
      await shot(page, 34, "desk-fork-samples-scrolled");
    }
    await page.getByTestId(`sample-${way.photo}`).click();
    await expect(page.getByTestId("place-name")).toHaveText(PLACES.P1.name, { timeout: 30_000 });
    await expect(page.getByTestId("stored-note")).toContainText("Stored result");
    await expect(page.getByTestId("verdict-detail")).toContainText(way.cue);
    if (first) await shot(page, 35, "desk-fork-result");
    await page.getByTestId("after-result").click();
    await expect(page.getByTestId("fork-choice")).toContainText(way.cue);
    await expect(page.getByTestId("fork-choice")).toContainText("stored result");
    await shot(page, first ? 36 : 40, `desk-fork-bridge-${way.cue}`);
    await page.getByTestId("to-next-clue").click();
    await expect(page.getByTestId("route-so-far")).toContainText(PLACES.P1.name);

    // The next stop is the one this photo picked.
    expect(await sample(page, way.nextPhoto)).toBe(PLACES[way.next].name);
    if (first) await shot(page, 37, "desk-stop2-result");
    await page.getByTestId("after-result").click();
    await page.getByTestId("to-next-clue").click();
    expect(await sample(page, "p4-stairs")).toBe(PLACES.P4.name);
    await page.getByTestId("after-result").click();

    // The finale and the case file.
    await expect(page.getByTestId("answer")).toBeVisible();
    if (first) await shot(page, 38, "desk-finale");
    await page.getByTestId("open-case-file").click();
    await page.waitForURL(/\/end\//);
    await expect(page.getByTestId("case-title")).toBeVisible();
    const route = page.getByTestId("route");
    await expect(route.locator("li")).toHaveCount(3);
    await expect(route).toContainText(PLACES.P1.name);
    await expect(route).toContainText(PLACES[way.next].name);
    await expect(route).toContainText(PLACES.P4.name);
    await expect(page.getByTestId("not-taken")).toContainText(`Had you photographed ${way.other}.`);
    await expect(page.getByTestId("photos").locator("img")).toHaveCount(3);
    const facts = page.getByTestId("facts").getByTestId("fact");
    expect(await facts.count()).toBeGreaterThan(3);
    for (const fact of await facts.all()) {
      await expect(fact).toContainText(/Wikipedia|Google Maps via SerpApi|Google Search via SerpApi/);
      await expect(fact).toContainText("query");
      await expect(fact.locator("a[href^='https://']")).toHaveCount(1);
    }
    await expect(page.getByTestId("receipt")).toContainText("SCREEN ON");
    await expect(page.getByTestId("receipt-desk")).toContainText("THE WALK WAS SKIPPED");
    await expect(page.getByTestId("desk-again")).toBeVisible();
    if (first) {
      await shot(page, 39, "desk-case-file");
      await scrollToTestId(page, "route", 90);
      await shot(page, 41, "desk-case-route");
      await scrollToTestId(page, "not-taken", 90);
      await shot(page, 42, "desk-case-road-not-taken");
      await scrollToTestId(page, "facts", 120);
      await shot(page, 43, "desk-case-facts");
      await scrollToTestId(page, "receipt", 60);
      await shot(page, 44, "desk-receipt");
      await shot(page, 45, "desk-case-file-full", { fullPage: true });
    } else {
      await scrollToTestId(page, "not-taken", 90);
      await shot(page, 46, "desk-case-road-not-taken-water");
    }
    await context.close();
  });
}

test("desk demo on a laptop (1280 x 800), location denied", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await deniedPhone(browser, { width: 1280, height: 800 }, false);
  const page = await context.newPage();
  await page.goto("/demo");
  await expect(page.getByTestId("desk-intro")).toBeVisible();
  await shot(page, 60, "laptop-desk-intro");
  await begin(page);
  await page.getByTestId("desk-arrive").click();
  await expect(page.getByTestId("sample-p1-water")).toBeVisible();
  await shot(page, 61, "laptop-desk-fork-samples");
  await page.getByTestId("sample-p1-water").click();
  await expect(page.getByTestId("place-name")).toHaveText(PLACES.P1.name, { timeout: 30_000 });
  await shot(page, 62, "laptop-desk-fork-result");
  // Nothing is wider than the window.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
  await context.close();
});
