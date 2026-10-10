import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Source maps and releases go to Sentry only from a hosted build (Render or CI) that has the
// auth token, org and project. Local builds never upload anything.
const hostedBuild = process.env.RENDER === "true" || process.env.CI === "true";
const uploadToSentry = Boolean(
  hostedBuild &&
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // An empty token, not undefined: the build plugin falls back to SENTRY_AUTH_TOKEN from
  // .env.local and would then call Sentry's release API (set commits) from a local build.
  authToken: uploadToSentry ? process.env.SENTRY_AUTH_TOKEN : "",
  silent: true,
  telemetry: false,
  sourcemaps: { disable: !uploadToSentry },
  release: uploadToSentry
    ? { create: true, finalize: true }
    : { create: false, finalize: false, setCommits: false },
});
