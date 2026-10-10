import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT, E2E_SERVER_ENV } from "./e2e/env";

// Browser checks: `pnpm build && pnpm e2e`. Playwright starts the production build on port 3200
// with the settings in e2e/env.ts (no paid API call, deterministic results) and stops it after.
// They use the system Chrome, headless, with a fresh temporary profile.
//
// With E2E_BASE_URL set, no server is started: the checks run against that server instead
// (the E2E_REAL specs need one with a working photo reader; see their headers).
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  workers: 1, // one browser at a time: the checks share one server and one database
  fullyParallel: false,
  timeout: 60_000,
  globalSetup: external ? undefined : "./e2e/global-setup.ts",
  use: {
    baseURL: external ?? `http://localhost:${E2E_PORT}`,
    channel: "chrome",
    headless: true,
  },
  webServer: external
    ? undefined
    : {
        command: `pnpm start -p ${E2E_PORT}`,
        url: `http://localhost:${E2E_PORT}/`,
        reuseExistingServer: false,
        timeout: 60_000,
        env: E2E_SERVER_ENV,
        stdout: process.env.E2E_SERVER_LOG ? "pipe" : "ignore",
        stderr: "pipe",
      },
  projects: [
    {
      name: "phone",
      use: {
        ...devices["iPhone 13"],
        defaultBrowserType: "chromium",
        channel: "chrome",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
