import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * The phone play loop, end to end, on the mock adapter (no server routes, no network):
 * start → briefing → clue → pocket → I'm here → photo → result → fork → … → finale → case file.
 *
 * It needs a mock build (NEXT_PUBLIC_MOCK_API=1 pnpm build) or `pnpm dev`, so it runs only with
 * E2E_MOCK=1 and E2E_BASE_URL set to that server. The default checks (`pnpm e2e`) play the real
 * routes instead.
 *
 * Screenshots: set SHOTS_DIR to an absolute folder (and SHOTS_PREFIX for the file names).
 */

test.skip(process.env.E2E_MOCK !== "1", "needs a mock build or the dev server (E2E_MOCK=1)");

const SHOTS_DIR = process.env.SHOTS_DIR;
const PREFIX = process.env.SHOTS_PREFIX ?? "play";
const START = { latitude: 41.026, longitude: 28.975, accuracy: 12 };

async function shot(page: Page, n: number, name: string, fullPage = false) {
  if (!SHOTS_DIR) return;
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }); // the dev-only badge
  await page.waitForTimeout(450); // let the entry motion settle
  await page.screenshot({ path: `${SHOTS_DIR}/${PREFIX}-${String(n).padStart(2, "0")}-${name}.png`, fullPage });
}

async function controls(page: Page, value: Record<string, unknown>) {
  await page.evaluate((v) => localStorage.setItem("fp:mock-controls", JSON.stringify(v)), value);
}

/** A stand-in photo drawn on a canvas: carved lettering on stone, or water from a spout. */
async function photo(page: Page, kind: "writing" | "water" | "stone"): Promise<Buffer> {
  const dataUrl = await page.evaluate((k) => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 1200;
    const g = c.getContext("2d")!;
    if (k === "water") {
      const sky = g.createLinearGradient(0, 0, 0, 1200);
      sky.addColorStop(0, "#5d8fb8");
      sky.addColorStop(1, "#1f4f78");
      g.fillStyle = sky;
      g.fillRect(0, 0, 1600, 1200);
      g.fillStyle = "#b9b2a3";
      g.fillRect(560, 0, 480, 520);
      g.fillStyle = "#8a6d3b";
      g.fillRect(760, 470, 80, 70);
      g.strokeStyle = "rgba(220,235,250,0.9)";
      g.lineWidth = 18;
      g.beginPath();
      g.moveTo(800, 540);
      g.bezierCurveTo(805, 700, 790, 900, 800, 1200);
      g.stroke();
    } else {
      g.fillStyle = k === "writing" ? "#cfc6b4" : "#a59c8c";
      g.fillRect(0, 0, 1600, 1200);
      g.fillStyle = "rgba(0,0,0,0.08)";
      for (let i = 0; i < 40; i++) g.fillRect(Math.random() * 1600, Math.random() * 1200, 90, 4);
      g.strokeStyle = "#6f6656";
      g.lineWidth = 10;
      g.strokeRect(260, 220, 1080, 760);
      if (k === "writing") {
        g.lineWidth = 9;
        for (let row = 0; row < 4; row++) {
          g.beginPath();
          for (let x = 340; x < 1260; x += 60) {
            const y = 340 + row * 170;
            g.moveTo(x, y + 30);
            g.quadraticCurveTo(x + 20, y - 25, x + 45, y + 20);
          }
          g.stroke();
        }
      }
    }
    return c.toDataURL("image/jpeg", 0.9);
  }, kind);
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

type AudioEvent = { kind: string; tag?: string };
type Paused = { speech: boolean; ambience: boolean; sfx: boolean };
const audioPaused = (page: Page) => page.evaluate(() => (window as unknown as { __fpAudioPaused: () => Paused }).__fpAudioPaused());
const audioLog = (page: Page) => page.evaluate(() => ((window as unknown as { __fpAudioLog?: AudioEvent[] }).__fpAudioLog ?? []).map((e) => ({ kind: e.kind, tag: e.tag })));

async function startWalk(page: Page, minutes: 15 | 25) {
  await page.goto("/?mock=1");
  await expect(page.getByTestId("located")).toBeVisible();
  await page.getByTestId(`minutes-${minutes}`).click();
  await page.getByTestId("start").click();
  await page.waitForURL(/\/play\//);
  await expect(page.getByTestId("mystery")).toBeVisible();
}

/** From a clue screen: walk, arrive, photograph; returns the revealed place name. */
async function playStop(page: Page, kind: "writing" | "water" | "stone", cue?: string) {
  await page.getByTestId("go").click();
  await page.getByTestId("im-here").click();
  await controls(page, cue ? { cue } : {});
  await page.getByTestId("camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await photo(page, kind) });
  await expect(page.getByTestId("place-name")).toBeVisible();
  return page.getByTestId("place-name").innerText();
}

async function phoneContext(context: BrowserContext) {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(START);
}

test("plays the 15-minute walk end to end, with the road not taken and the receipt", async ({ page, context }) => {
  test.setTimeout(120_000);
  await phoneContext(context);
  await page.goto("/?mock=1");
  await controls(page, {});
  await expect(page.getByTestId("located")).toBeVisible();
  await shot(page, 1, "start");
  await page.getByTestId("start").click();
  await page.waitForURL(/\/play\//);

  // Briefing: the safety line, the narrator over the ambience.
  await expect(page.getByTestId("safety")).toContainText("Stay on the pavement, daylight only.");
  await page.getByTestId("briefing-play").click();
  await shot(page, 3, "briefing");
  await page.getByTestId("to-clue").click();

  // Clue 1 (a fork), then pocket mode.
  await expect(page.getByTestId("clue")).toBeVisible();
  await page.getByTestId("clue-play").click();
  await shot(page, 4, "clue");
  await page.getByTestId("go").click();
  await expect(page.getByTestId("pocket")).toContainText("Lock your phone. Go.");
  await shot(page, 5, "pocket");
  await setHidden(page, true);
  await page.waitForTimeout(1500);
  await setHidden(page, false);

  // At the place: the fork's look line, then the camera.
  await page.getByTestId("im-here").click();
  await expect(page.getByTestId("fork-note")).toBeVisible();
  await shot(page, 6, "look-fork");
  await controls(page, { cue: "writing" });
  await page.getByTestId("camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await photo(page, "writing") });
  await shot(page, 7, "checking");
  await expect(page.getByTestId("place-name")).toHaveText("Test Square Fountain");
  await expect(page.getByTestId("observed")).toContainText("carved lettering");
  await shot(page, 8, "result-reveal");
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("fork-choice")).toContainText("writing");
  await expect(page.getByTestId("bridge")).toContainText("Carved lettering");
  await shot(page, 9, "fork-bridge");
  await page.getByTestId("to-next-clue").click();

  // Stop 2: too far first, then found.
  await page.getByTestId("go").click();
  await page.getByTestId("im-here").click();
  await controls(page, { far: true });
  await page.getByTestId("camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await photo(page, "stone") });
  await expect(page.getByTestId("too-far")).toBeVisible();
  await expect(page.getByTestId("distance")).toHaveText(/\d+ m/);
  await shot(page, 10, "too-far");
  await controls(page, {});
  await page.getByTestId("check-again").click();
  await page.getByTestId("camera").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: await photo(page, "stone") });
  await expect(page.getByTestId("place-name")).toHaveText("Test Library");
  await page.getByTestId("after-result").click();
  await page.getByTestId("to-next-clue").click();

  // Stop 3: the answer.
  const last = await playStop(page, "stone");
  expect(last).toBe("Test Clock Tower");
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("answer")).toBeVisible();
  await page.getByTestId("finale-play").click();
  await shot(page, 11, "finale");
  await page.getByTestId("open-case-file").click();
  await page.waitForURL(/\/end\//);

  // Case file: route, road not taken, photos, every fact with source, query and link.
  await expect(page.getByTestId("case-title")).toBeVisible();
  await expect(page.getByTestId("not-taken")).toContainText(
    "Had you photographed the water, you would have gone to Test Bathhouse.",
  );
  await expect(page.getByTestId("photos").locator("img")).toHaveCount(3);
  const facts = page.getByTestId("facts").getByTestId("fact");
  await expect(facts).toHaveCount(6); // every fact the quest cites
  for (const fact of await facts.all()) {
    await expect(fact).toContainText(/Wikipedia|Google Maps via SerpApi|Google Search via SerpApi/);
    await expect(fact).toContainText("query");
    await expect(fact.locator("a[href^='https://']")).toHaveCount(1);
  }
  await expect(page.getByTestId("receipt")).toContainText("SCREEN ON");
  await expect(page.getByTestId("pocket")).not.toHaveText(/^0:00/);
  await shot(page, 12, "case-file");
  const scrollTo = (id: string, offset: number) =>
    page.evaluate(
      ([i, o]) => window.scrollTo(0, document.querySelector(`[data-testid=${i}]`)!.getBoundingClientRect().top + window.scrollY - (o as number)),
      [id, offset] as const,
    );
  await scrollTo("route", 40);
  await shot(page, 13, "route-road-not-taken");
  await scrollTo("photos", 90);
  await shot(page, 14, "photos-facts");
  await scrollTo("receipt", 70);
  await shot(page, 15, "receipt");
  await shot(page, 16, "case-file-full", true);
});

test("audio rules: ambience only under the briefing and clues, stingers on results, silence in pocket mode", async ({ page, context }) => {
  test.setTimeout(60_000);
  await phoneContext(context);
  await page.goto("/?mock=1");
  await controls(page, {});
  await startWalk(page, 15);
  await page.getByTestId("briefing-play").click();
  // The narrator speaks over the ambience: both elements play.
  await expect.poll(() => audioPaused(page)).toMatchObject({ speech: false, ambience: false });
  await page.getByTestId("to-clue").click();
  await page.getByTestId("clue-play").click();
  await expect.poll(() => audioPaused(page)).toMatchObject({ speech: false, ambience: false });
  // Pocket mode: every element is silent.
  await page.getByTestId("go").click();
  await expect(page.getByTestId("pocket")).toBeVisible();
  await expect.poll(() => audioPaused(page)).toEqual({ speech: true, ambience: true, sfx: true });
  await page.waitForTimeout(500);
  expect(await audioPaused(page)).toEqual({ speech: true, ambience: true, sfx: true });
  await page.getByTestId("replay").click();
  await page.getByTestId("clue-play").click();
  await page.waitForTimeout(300);
  await playStop(page, "writing", "writing");
  await page.getByTestId("reveal-play").click();
  await page.waitForTimeout(300);
  const log = await audioLog(page);
  const ambience = log.filter((e) => e.kind === "ambience");
  expect(ambience.length).toBeGreaterThanOrEqual(2);
  expect(ambience.every((e) => e.tag === "briefing" || e.tag === "clue")).toBe(true);
  expect(log.some((e) => e.kind === "stinger" && e.tag === "result")).toBe(true);
  // Entering pocket mode silences everything, and nothing starts until the player is at the place.
  const pocketAt = log.map((e) => `${e.kind}:${e.tag}`).lastIndexOf("stop:pocket");
  const arriveAt = log.findIndex((e) => e.kind === "stop" && e.tag === "arrive");
  expect(pocketAt).toBeGreaterThan(-1);
  expect(log.slice(pocketAt + 1, arriveAt).filter((e) => e.kind !== "stop")).toEqual([]);
  // The reveal line plays without ambience.
  expect(log.at(-1)).toMatchObject({ kind: "speech", tag: "reveal" });
});

test("the other photo at the fork leads to the other stop, and both meet at the answer", async ({ page, context }) => {
  test.setTimeout(60_000);
  await phoneContext(context);
  await page.goto("/?mock=1");
  await controls(page, {});
  await startWalk(page, 15);
  await page.getByTestId("to-clue").click();
  expect(await playStop(page, "water", "water")).toBe("Test Square Fountain");
  await page.getByTestId("after-result").click();
  await expect(page.getByTestId("fork-choice")).toContainText("water");
  await page.getByTestId("to-next-clue").click();
  expect(await playStop(page, "stone")).toBe("Test Bathhouse");
  await page.getByTestId("after-result").click();
  await page.getByTestId("to-next-clue").click();
  expect(await playStop(page, "stone")).toBe("Test Clock Tower");
  await page.getByTestId("after-result").click();
  await page.getByTestId("open-case-file").click();
  await expect(page.getByTestId("not-taken")).toContainText(
    "Had you photographed the writing, you would have gone to Test Library.",
  );
});

test("the 25-minute walk has two forks and shows both roads not taken", async ({ page, context }) => {
  test.setTimeout(90_000);
  await phoneContext(context);
  await page.goto("/?mock=1");
  await controls(page, {});
  await startWalk(page, 25);
  await page.getByTestId("to-clue").click();
  const names: string[] = [];
  for (const [kind, cue] of [["water", "water"], ["stone", "door-window-arch"], ["stone", undefined], ["stone", undefined]] as const) {
    names.push(await playStop(page, kind, cue));
    await page.getByTestId("after-result").click();
    if (names.length < 4) await page.getByTestId("to-next-clue").click();
  }
  expect(names[0]).toBe("Test Pier Fountain");
  expect(names[1]).toBe("Test Bathhouse");
  expect(names[3]).toBe("Test Observatory");
  await page.getByTestId("open-case-file").click();
  await expect(page.getByTestId("not-taken").locator("> div")).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, document.querySelector("[data-testid=route]")!.getBoundingClientRect().top + window.scrollY - 330));
  await shot(page, 17, "case-file-two-forks");
});

test("a reload keeps the walk (lock and unlock keep the state)", async ({ page, context }) => {
  test.setTimeout(60_000);
  await phoneContext(context);
  await page.goto("/?mock=1");
  await controls(page, {});
  await startWalk(page, 25);
  await page.getByTestId("to-clue").click();
  await page.getByTestId("go").click();
  await page.reload();
  await expect(page.getByTestId("pocket")).toBeVisible();
  await page.getByTestId("im-here").click();
  await page.reload();
  await expect(page.getByTestId("fork-note")).toBeVisible();
});

test("without location, the start page offers the desk demo", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    permissions: [],
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const deny = (_ok: unknown, fail?: (e: GeolocationPositionError) => void) =>
      fail?.({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
    Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: deny, watchPosition: deny, clearWatch: () => undefined } });
  });
  await page.goto("/");
  // The permission may already read as blocked; otherwise ask.
  await page.getByTestId("locate").click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByTestId("location-denied")).toBeVisible();
  await expect(page.getByTestId("start")).toBeDisabled();
  await expect(page.getByTestId("desk-demo")).toHaveAttribute("href", "/demo");
  await expect(page.getByTestId("desk-demo")).toContainText("Try it from your desk");
  await shot(page, 2, "start-no-location");
  await context.close();
});
