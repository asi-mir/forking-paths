// Sentry for the Edge runtime (proxy, edge routes). AI routes run on Node.js, not here.
// Loaded by src/instrumentation.ts. Without a DSN nothing is initialised and nothing is sent.
import * as Sentry from "@sentry/nextjs";
import { DATA_COLLECTION, TRACES_SAMPLE_RATE, prepareSpan } from "./src/lib/sentry-privacy";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    dataCollection: DATA_COLLECTION,
    tracePropagationTargets: [],
    beforeSendSpan: prepareSpan,
  });
}
