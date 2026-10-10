// Sentry in the browser: page loads, navigations and the calls to our own API. No session replay.
// Without a DSN, nothing runs.
import * as Sentry from "@sentry/nextjs";
import { DATA_COLLECTION, TRACES_SAMPLE_RATE, prepareSpan } from "./lib/sentry-privacy";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Same label as the server (sentry.server.config.ts) when NEXT_PUBLIC_SENTRY_ENVIRONMENT is set.
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    dataCollection: DATA_COLLECTION,
    // No trace headers on fetches, not even to our own API: a page view would otherwise carry one
    // trace id into every request it makes, and the quest generation and each photo check would
    // merge into one trace. Each API request starts its own server trace instead.
    tracePropagationTargets: [],
    // Cuts query strings (they can hold the player's position) from fetch and page spans.
    beforeSendSpan: prepareSpan,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
