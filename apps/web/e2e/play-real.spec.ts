import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * The play loop end to end against the real routes (no mock): the Karaköy demo quest, the photo
 * reader on Gemma, photos from the reader eval set (Wikimedia Commons, `pnpm eval:photos:fetch`),
 * and the phone's position set to each stop. It needs a running server with a reader, so it runs
 * only with E2E_REAL=1:
 *
 *   E2E_REAL=1 E2E_BASE_URL=http://localhost:3122 pnpm exec playwright test e2e/play-real.spec.ts
 *
 * With local Gemma, set OLLAMA_PS_URL (e.g. http://127.0.0.1:11434/api/ps): the walk to the first
 * stop then waits until the reader model is loaded, as a real walk of a minute or more would.
 * Screenshots: SHOTS_DIR (absolute) and SHOTS_PREFIX.
 */

test.skip(process.env.E2E_REAL !== "1", "needs a running server with a photo reader (E2E_REAL=1)");

const SHOTS_DIR = process.env.SHOTS_DIR;
const PREFIX = process.env.SHOTS_PREFIX ?? "real";
const PHOTOS = join(process.cwd(), "eval/photos/.cache");

// The demo quest's places (src/quest/__fixtures__/karakoy.json).
const PLACES = {
  P1: { latitude: 41.02583333, longitude: 28.97416667 }, // Bereketzade Fountain (the fork)
  P2: { latitude: 41.02507498, longitude: 28.97418708 }, // Bereketzade Ali Efendi Mosque
  P3: { latitude: 41.02555556, longitude: 28.975 }, // Hasan Ağa Fountain
  P4: { latitude: 41.02388889, longitude: 28.97388889 }, // Camondo Stairs (the answer)
} as const;
type PlaceId = keyof typeof PLACES;

async function shot(page: Page, n: number, name: string, fullPage = false) {
  if (!SHOTS_DIR) return;
  await page.waitForTimeout(450); // let the entry motion settle
  await page.screenshot({ path: `${SHOTS_DIR}/${PREFIX}-${String(n).padStart(2, "0")}-${name}.png`, fullPage });
}

async function at(context: BrowserContext, id: PlaceId, northM = 0) {
  const p = PLACES[id];
  await context.setGeolocation({ latitude: p.latitude + northM / 111_195, longitude: p.longitude, accuracy: 8 });
}

/** A real walk takes a minute or more to the first stop: wait until local Gemma has loaded. */
async function walkToFirstStop() {
  const url = process.env.OLLAMA_PS_URL;
  if (!url) return;
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const ps = (await (await fetch(url)).json().catch(() => ({}))) as { models?: unknown[] };
    if (ps.models?.length) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function upload(page: Page, file: string) {
  await page.getByTestId("camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: readFileSync(join(PHOTOS, `${file}.jpg`)) });
}

/** From a clue screen: walk (pocket), arrive at `id`, photograph `file`; returns the revealed name. */
async function stop(page: Page, context: BrowserContext, id: PlaceId, file: string) {
  await page.getByTestId("go").click();
  await expect(page.getByTestId("pocket")).toBeVisible();
  await at(context, id);
  await page.getByTestId("im-here").click();
  await upload(page, file);
  await expect(page.getByTestId("place-name")).toBeVisible({ timeout: 70_000 });
  return page.getByTestId("place-name").innerText();
}

async function begin(page: Page, context: BrowserContext) {
  await context.grantPermissions(["geolocation"]);
  await at(context, "P1", 120); // the player starts a short walk from the first stop
  await page.goto("/?quest=demo-karakoy");
  await expect(page.getByTestId("located")).toBeVisible();
  await page.getByTestId("start").click();
  await page.waitForURL(/\/play\//, { timeout: 90_000 });
  await expect(page.getByTestId("mystery")).toBeVisible();
}

test("the writing branch with one too-far retry: P1 → P2 → P4, finale and case file", async ({ page, context }) => {
  test.setTimeout(420_000);
  await begin(page, context);
  await shot(page, 1, "briefing");
  await page.getByTestId("to-clue").click();
  await expect(page.getByTestId("clue")).toBeVisible();
  await shot(page, 2, "clue");

  // Stop 1, the fork: an inscription plaque.
  await page.getByTestId("go").click();
  await expect(page.getByTestId("pocket")).toContainText("Lock your phone. Go.");
  await shot(page, 3, "pocket");
  await walkToFirstStop();
  await at(context, "P1");
  await page.getByTestId("im-here").click();
  await expect(page.getByTestId("fork-note")).toBeVisible();
  await shot(page, 4, "look-fork");
  await upload(page, "plaque-german-fountain");
  await expect(page.getByTestId("place-name")).toHaveText("Bereketzade Fountain", { timeout: 70_000 });
  await expect(page.getByTestId("observed")).toBeVisible();
  await shot(page, 5, "result-reveal");
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("fork-choice")).toContainText("writing");
  await expect(page.getByTestId("bridge")).toBeVisible();
  await shot(page, 6, "fork-bridge-writing");
  await page.getByTestId("to-next-clue").click();

  // Stop 2: too far first (GPS 400 m off), then found.
  await page.getByTestId("go").click();
  await at(context, "P2", 400);
  await page.getByTestId("im-here").click();
  await upload(page, "arched-door-istanbul");
  await expect(page.getByTestId("too-far")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("distance")).toHaveText(/\d+ m/);
  await shot(page, 7, "too-far");
  await at(context, "P2"); // "Check again" reads GPS once, like "I'm here"
  await page.getByTestId("check-again").click();
  await upload(page, "arched-door-istanbul");
  await expect(page.getByTestId("place-name")).toHaveText("Bereketzade Ali Efendi Mosque", { timeout: 70_000 });
  await page.getByTestId("after-result").click();
  await page.getByTestId("to-next-clue").click();

  // Stop 3: the answer place.
  expect(await stop(page, context, "P4", "wooden-door-istanbul")).toBe("Camondo Stairs");
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("answer")).toBeVisible();
  await shot(page, 8, "finale");
  await page.getByTestId("open-case-file").click();
  await page.waitForURL(/\/end\//);
  await expect(page.getByTestId("case-title")).toBeVisible();
  await expect(page.getByTestId("not-taken")).toContainText("Had you photographed the water, you would have gone to Hasan Ağa Fountain.");
  const facts = page.getByTestId("facts").getByTestId("fact");
  expect(await facts.count()).toBeGreaterThan(0);
  for (const fact of await facts.all()) await expect(fact.locator("a[href^='https://']")).toHaveCount(1);
  await expect(page.getByTestId("receipt")).toContainText("SCREEN ON");
  await shot(page, 9, "case-file");
  await page.evaluate(() => window.scrollTo(0, document.querySelector("[data-testid=route]")!.getBoundingClientRect().top + window.scrollY - 40));
  await shot(page, 10, "route-road-not-taken");
  // The receipt names the Gemma that read the photos, and where (E2E_CHECKER, e.g.
  // "Gemma 4 E4B on my laptop (Ollama)").
  await expect(page.getByTestId("photo-check")).toContainText(process.env.E2E_CHECKER ?? /Gemma 4 .+ on /);
  await page.evaluate(() => window.scrollTo(0, document.querySelector("[data-testid=receipt]")!.getBoundingClientRect().top + window.scrollY - 40));
  await shot(page, 13, "receipt-photo-check");
});

test("the water branch: P1 → P3 → P4, and the case file shows the writing road not taken", async ({ page, context }) => {
  test.setTimeout(420_000);
  await begin(page, context);
  await page.getByTestId("to-clue").click();
  await page.getByTestId("go").click();
  await walkToFirstStop();
  await at(context, "P1");
  await page.getByTestId("im-here").click();
  await upload(page, "old-spring-istanbul");
  await expect(page.getByTestId("place-name")).toHaveText("Bereketzade Fountain", { timeout: 70_000 });
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("fork-choice")).toContainText("water");
  await shot(page, 11, "fork-bridge-water");
  await page.getByTestId("to-next-clue").click();
  expect(await stop(page, context, "P3", "lion-head-tap")).toBe("Hasan Ağa Fountain");
  await page.getByTestId("after-result").click();
  await page.getByTestId("to-next-clue").click();
  expect(await stop(page, context, "P4", "wooden-door-istanbul")).toBe("Camondo Stairs");
  await page.getByTestId("after-result").click();
  await page.getByTestId("open-case-file").click();
  await page.waitForURL(/\/end\//);
  await expect(page.getByTestId("not-taken")).toContainText(
    "Had you photographed the writing, you would have gone to Bereketzade Ali Efendi Mosque.",
  );
  await page.evaluate(() => window.scrollTo(0, document.querySelector("[data-testid=route]")!.getBoundingClientRect().top + window.scrollY - 40));
  await shot(page, 12, "case-file-water");
});
