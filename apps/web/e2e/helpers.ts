import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import { MongoClient } from "mongodb";
import { E2E_DB, E2E_MONGODB_URI, E2E_SERVER_ENV } from "./env";

/**
 * Shared pieces of the browser checks. Screenshots go to SHOTS_DIR (absolute) when it is set,
 * as NN-<name>.png in flow order; without it, no screenshot is written.
 */

const SHOTS_DIR = process.env.SHOTS_DIR;

export async function shot(page: Page, n: number, name: string, opts: { fullPage?: boolean } = {}) {
  if (!SHOTS_DIR) return;
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(500); // let the entry motion settle
  await page.screenshot({ path: `${SHOTS_DIR}/${String(n).padStart(2, "0")}-${name}.png`, fullPage: opts.fullPage ?? false });
}

/** Scrolls so the element with this test id sits `offset` px below the top of the screen. */
export async function scrollToTestId(page: Page, id: string, offset = 40) {
  await page.evaluate(
    ([i, o]) => {
      const el = document.querySelector(`[data-testid="${i}"]`);
      if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - Number(o));
    },
    [id, offset] as const,
  );
}

/** The demo quest's places (src/quest/__fixtures__/karakoy.json). */
export const PLACES = {
  P1: { latitude: 41.02583333, longitude: 28.97416667, name: "Bereketzade Fountain" }, // the fork
  P2: { latitude: 41.02507498, longitude: 28.97418708, name: "Bereketzade Ali Efendi Mosque" }, // the writing way
  P3: { latitude: 41.02555556, longitude: 28.975, name: "Hasan Ağa Fountain" }, // the water way
  P4: { latitude: 41.02388889, longitude: 28.97388889, name: "Camondo Stairs" }, // the answer
} as const;
export type PlaceId = keyof typeof PLACES;

/** Puts the phone at a place, or `northM` metres north of it. */
export async function at(context: BrowserContext, id: PlaceId, northM = 0) {
  const p = PLACES[id];
  await context.setGeolocation({ latitude: p.latitude + northM / 111_195, longitude: p.longitude, accuracy: 8 });
}

/** No browser error reports leave the machine during the checks. */
export async function offline(context: BrowserContext) {
  await context.route(/sentry\.io|ingest\.(de|us)\.sentry/, (route) => route.abort());
}

/** A phone context with location denied: getCurrentPosition fails as a blocked permission does. */
export async function deniedPhone(browser: Browser, viewport = { width: 390, height: 844 }, mobile = true) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    permissions: [],
  });
  await offline(context);
  await context.addInitScript(() => {
    const deny = (_ok: unknown, fail?: (e: GeolocationPositionError) => void) =>
      setTimeout(() => fail?.({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError), 50);
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition: deny, watchPosition: deny, clearWatch: () => undefined },
    });
  });
  return context;
}

/** A stand-in street photo drawn on a canvas (any JPEG will do: the reader is off in the checks). */
export async function streetPhoto(page: Page, hue = 30): Promise<Buffer> {
  const dataUrl = await page.evaluate((h) => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 1200;
    const g = c.getContext("2d")!;
    g.fillStyle = `hsl(${h} 18% 72%)`;
    g.fillRect(0, 0, 1600, 1200);
    g.strokeStyle = `hsl(${h} 20% 35%)`;
    g.lineWidth = 10;
    g.strokeRect(260, 220, 1080, 760);
    for (let row = 0; row < 4; row++) {
      g.beginPath();
      for (let x = 340; x < 1260; x += 60) {
        const y = 340 + row * 170;
        g.moveTo(x, y + 30);
        g.quadraticCurveTo(x + 20, y - 25, x + 45, y + 20);
      }
      g.stroke();
    }
    return c.toDataURL("image/jpeg", 0.9);
  }, hue);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

export async function takePhoto(page: Page, hue = 30) {
  await page.getByTestId("camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await streetPhoto(page, hue) });
}

/** Hides or shows the page as a phone lock or unlock does (the page sees visibilitychange). */
export async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

// ---------------------------------------------------------------------------
// The test database

async function withDb<T>(fn: (db: ReturnType<MongoClient["db"]>) => Promise<T>): Promise<T> {
  const client = await MongoClient.connect(E2E_MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    return await fn(client.db(E2E_DB));
  } finally {
    await client.close();
  }
}

export type AttemptRow = { placeId: string; passed: boolean; provider: string | null; verdict: unknown; distanceM: number | null };

/** A run's photo attempts as the server stored them, oldest first. */
export const attemptsOf = (runId: string) =>
  withDb((db) => db.collection("attempts").find({ runId }, { sort: { at: 1 } }).toArray() as unknown as Promise<AttemptRow[]>);

export const deleteQuest = (id: string) => withDb((db) => db.collection<{ _id: string }>("quests").deleteOne({ _id: id }));

export const questCount = () => withDb((db) => db.collection("quests").countDocuments());

/** Stores (or removes) the test clips of the demo quest (e2e/voice-clips.ts). */
export function voiceClips(command: "seed" | "clear") {
  execFileSync("pnpm", ["exec", "tsx", "e2e/voice-clips.ts", command], {
    env: { ...process.env, MONGODB_URI: E2E_SERVER_ENV.MONGODB_URI, MONGODB_DB: E2E_SERVER_ENV.MONGODB_DB },
    stdio: "pipe",
  });
}

/** The run id in the page's URL (/play/<id> or /end/<id>). */
export const runIdOf = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.split("/").pop() ?? "");

/** Every narrator line on screen has its words, whether or not it has a clip. */
export async function linesHaveText(page: Page) {
  const quotes = page.locator("figure blockquote");
  const n = await quotes.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) expect((await quotes.nth(i).innerText()).trim().length).toBeGreaterThan(10);
}

/**
 * Tap targets smaller than 44 x 44 px on screen (links inside running text are exempt: they are
 * read, not aimed at). Returns a short description of each, for the failure message.
 */
export async function smallTapTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const els = document.querySelectorAll<HTMLElement>("a[href], button, label, input:not([type=hidden]), summary, [role=button]");
    for (const el of els) {
      if (el instanceof HTMLInputElement && el.closest("label")) continue; // the label is the target
      if (el instanceof HTMLInputElement && getComputedStyle(el).opacity === "0") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      // A link inside a sentence (a photo credit) is fine at text size.
      const parent = el.parentElement;
      const inSentence =
        el.tagName === "A" &&
        parent !== null &&
        ["P", "FIGCAPTION", "SPAN"].includes(parent.tagName) &&
        (parent.textContent ?? "").trim().length > (el.textContent ?? "").trim().length + 5;
      if (inSentence) continue;
      if (r.height < 44 || r.width < 44) out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}
