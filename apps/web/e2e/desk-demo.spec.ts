import { expect, type Page, test } from "@playwright/test";

/**
 * The desk demo end to end against the real routes: location never granted, the Karaköy quest,
 * the sample photos from public/demo/ read by the configured photo reader. Both fork choices,
 * the road not taken, a laptop viewport, and "Generate a quest near me" with the city picker
 * (Istanbul reuses the saved case, so no new quest is generated). Needs a running server:
 *
 *   E2E_REAL=1 E2E_BASE_URL=http://localhost:3109 pnpm exec playwright test e2e/desk-demo.spec.ts
 *
 * Screenshots: SHOTS_DIR (absolute) and SHOTS_PREFIX (default "desk").
 */

test.skip(process.env.E2E_REAL !== "1", "needs a running server with a photo reader (E2E_REAL=1)");

const SHOTS_DIR = process.env.SHOTS_DIR;
const PREFIX = process.env.SHOTS_PREFIX ?? "desk";

async function shot(page: Page, n: number, name: string, fullPage = false) {
  if (!SHOTS_DIR) return;
  await page.waitForTimeout(450); // let the entry motion settle
  await page.screenshot({ path: `${SHOTS_DIR}/${PREFIX}-${String(n).padStart(2, "0")}-${name}.png`, fullPage });
}

async function begin(page: Page) {
  await page.goto("/demo");
  await expect(page.getByTestId("desk-intro")).toBeVisible();
  await page.getByTestId("desk-start").click();
  await page.waitForURL(/\/play\//, { timeout: 90_000 });
  await expect(page.getByTestId("mystery")).toBeVisible();
  await page.getByTestId("to-clue").click();
}

/** From a clue screen: skip the walk, send a sample photo; returns the revealed place name. */
async function stop(page: Page, sampleId: string) {
  await page.getByTestId("desk-arrive").click();
  await expect(page.getByTestId("sample-picker")).toBeVisible();
  await page.getByTestId(`sample-${sampleId}`).click();
  await expect(page.getByTestId("place-name")).toBeVisible({ timeout: 70_000 });
  return page.getByTestId("place-name").innerText();
}

for (const [branch, sample, next, nextSample, other] of [
  ["writing", "p1-writing", "Bereketzade Ali Efendi Mosque", "p2-plaque", "the water, you would have gone to Hasan Ağa Fountain"],
  ["water", "p1-water", "Hasan Ağa Fountain", "p3-inscription", "the writing, you would have gone to Bereketzade Ali Efendi Mosque"],
] as const) {
  test(`desk demo, the ${branch} way: two sample photos at the fork, the road not taken at the end`, async ({ page, context }) => {
    test.setTimeout(360_000);
    await context.clearPermissions(); // location is never granted
    const first = branch === "writing";
    const n = first ? 1 : 20;
    if (first) {
      await page.goto("/demo");
      await shot(page, n, "desk-intro");
    }
    await begin(page);
    await shot(page, n + 1, `clue-${branch}`);
    await page.getByTestId("desk-arrive").click();
    await expect(page.getByTestId(`sample-p1-writing`)).toBeVisible();
    await expect(page.getByTestId(`sample-p1-water`)).toBeVisible();
    await expect(page.getByTestId("sample-credit").first()).toContainText("Wikimedia Commons");
    if (first) await shot(page, n + 2, "fork-samples", true);
    await page.getByTestId(`sample-${sample}`).click();
    await expect(page.getByTestId("place-name")).toHaveText("Bereketzade Fountain", { timeout: 70_000 });
    await expect(page.getByTestId("verdict-detail")).toBeVisible();
    await shot(page, n + 3, `fork-result-${branch}`);
    await page.getByTestId("after-result").click();
    await expect(page.getByTestId("fork-choice")).toContainText(branch);
    await shot(page, n + 4, `fork-bridge-${branch}`);
    await page.getByTestId("to-next-clue").click();
    await expect(page.getByTestId("route-so-far")).toContainText("Bereketzade Fountain");

    expect(await stop(page, nextSample)).toBe(next);
    await shot(page, n + 5, `stop2-${branch}`);
    await page.getByTestId("after-result").click();
    await page.getByTestId("to-next-clue").click();
    expect(await stop(page, "p4-stairs")).toBe("Camondo Stairs");
    await page.getByTestId("after-result").click();
    await expect(page.getByTestId("answer")).toBeVisible();
    if (first) await shot(page, n + 6, "finale");
    await page.getByTestId("open-case-file").click();
    await page.waitForURL(/\/end\//);
    await expect(page.getByTestId("not-taken")).toContainText(`Had you photographed ${other}.`);
    await expect(page.getByTestId("desk-again")).toBeVisible();
    await shot(page, n + 7, `case-file-${branch}`, true);
    await page.getByTestId("not-taken").scrollIntoViewIfNeeded();
    await shot(page, n + 8, `road-not-taken-${branch}`);
  });
}

test("desk demo on a laptop (1280 x 800), location denied", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
  const page = await context.newPage();
  await page.goto("/demo");
  await expect(page.getByTestId("desk-intro")).toBeVisible();
  await shot(page, 40, "laptop-desk-intro", false);
  await begin(page);
  await page.getByTestId("desk-arrive").click();
  await expect(page.getByTestId("sample-p1-water")).toBeVisible();
  await shot(page, 41, "laptop-fork-samples", false);
  await context.close();
});

test("generate a quest near me: location denied, the city picker, the saved case line by line", async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.clearPermissions();
  await page.goto("/demo/near");
  await page.getByTestId("near-locate").click();
  await expect(page.getByTestId("near-denied")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("city-istanbul")).toContainText("tested");
  await shot(page, 50, "near-city-picker");
  await page.getByTestId("city-istanbul").click();
  await expect(page.getByTestId("quest-preview")).toBeVisible({ timeout: 280_000 });
  await expect(page.getByTestId("preview-link").first()).toBeVisible();
  await expect(page.getByTestId("preview-facts").getByTestId("fact").first()).toBeVisible();
  await page.getByTestId("play-briefing").click();
  // Voice is off in checks (no ElevenLabs request): the line stays text and says why.
  await expect(page.getByTestId("line-text-only").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, 51, "near-preview");
});

/**
 * Run against a server whose reader cannot answer (e.g. GEMMA_READER_PROVIDER=ollama with
 * OLLAMA_BASE_URL at a closed port): the sample photo uses its stored result, labelled on screen.
 */
test("a sample photo uses its stored result, labelled, when the live reader fails", async ({ page, context }) => {
  test.skip(process.env.E2E_STORED !== "1", "needs a server whose reader fails (E2E_STORED=1)");
  test.setTimeout(180_000);
  await context.clearPermissions();
  await begin(page);
  await page.getByTestId("desk-arrive").click();
  await page.getByTestId("sample-p1-water").click();
  await expect(page.getByTestId("place-name")).toHaveText("Bereketzade Fountain", { timeout: 70_000 });
  await expect(page.getByTestId("stored-note")).toContainText("Stored result");
  await shot(page, 60, "stored-result");
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("fork-choice")).toContainText("stored result");
  await expect(page.getByTestId("fork-choice")).toContainText("water");
});
