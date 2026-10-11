import * as Sentry from "@sentry/nextjs";

/** Starts Sentry once per server instance, before any route runs. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

/** Reports errors from server components, route handlers and server actions. */
export const onRequestError = Sentry.captureRequestError;
