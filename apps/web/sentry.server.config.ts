// Sentry for the Node.js runtime: route handlers, server components and the Mastra agents.
// Loaded by src/instrumentation.ts. Without a DSN nothing is initialised and nothing is sent.
import * as Sentry from "@sentry/nextjs";
import { DATA_COLLECTION, TRACES_SAMPLE_RATE, prepareSpan, sampleTrace } from "./src/lib/sentry-privacy";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    // Takes precedence over the rate: every trace except the host's health check.
    tracesSampler: sampleTrace,
    dataCollection: DATA_COLLECTION,
    // No trace headers on calls to Google, SerpApi, ElevenLabs or Wikipedia.
    tracePropagationTargets: [],
    // Cuts query strings, drops prompts and outputs of any trace that carries a photo, and
    // copies our tags onto agent spans.
    beforeSendSpan: prepareSpan,
    // The Mastra integration is on by default when tracing is on: it adds a Sentry exporter to
    // the Mastra instance, so agent runs, model calls and tool calls become gen_ai spans.
    // SENTRY_DEBUG=1 prints what the SDK does.
  });
}
