import { defineConfig, devices } from "@playwright/test";

// Browser checks run against a server you start yourself (no webServer here).
// They use the system Chrome, headless, with a fresh temporary profile.
// The play specs open /?mock=1: run them against `pnpm dev`, or against a production build
// made with NEXT_PUBLIC_MOCK_API=1 (production ignores ?mock=1 otherwise).
export default defineConfig({
  testDir: "e2e",
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3200",
    channel: "chrome",
    headless: true,
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
