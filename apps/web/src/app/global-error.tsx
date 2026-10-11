"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/** Last-resort error screen for errors in the root layout. Reports the error to Sentry. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          padding: "1.5rem",
          fontFamily: "system-ui, sans-serif",
          background: "#111",
          color: "#f5f5f5",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Something went wrong.</h1>
        <p style={{ margin: 0, maxWidth: "20rem", lineHeight: 1.5 }}>Try again in a moment.</p>
        <button
          type="button"
          onClick={() => retry()}
          style={{
            minHeight: "3rem",
            minWidth: "10rem",
            fontSize: "1.125rem",
            borderRadius: "999px",
            border: "none",
            background: "#f5f5f5",
            color: "#111",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
