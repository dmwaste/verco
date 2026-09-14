"use client";

// App Router root error boundary. It replaces the root layout when the tree
// throws, so it is self-contained (its own <html>/<body>). Reports the error to
// Sentry (inert without a DSN) and shows a minimal, on-brand fallback.
import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";

import {
  handleStaleAction,
  STALE_ACTION_MESSAGE,
  type StaleActionOutcome,
} from "@/lib/bundle/stale-action";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  // A `<form action>` (sign out) or a transition (client switcher) on a
  // post-deploy bundle throws UnrecognizedActionError into this boundary —
  // reload once instead of stranding the user on the fallback (ADR 0023).
  const [stale, setStale] = useState<StaleActionOutcome | null>(null);

  useEffect(() => {
    Sentry.captureException(error);
    setStale(handleStaleAction(error));
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#293F52",
          color: "#FFFFFF",
          padding: "1.5rem",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0 0 0.75rem" }}>
            {stale ? "App updated" : "Something went wrong"}
          </h1>
          <p style={{ opacity: 0.85, lineHeight: 1.5, margin: "0 0 1.5rem" }}>
            {stale
              ? STALE_ACTION_MESSAGE[stale]
              : "An unexpected error occurred. Please try again — if it keeps happening, come back a little later."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              background: "#00E47C",
              color: "#293F52",
              border: "none",
              borderRadius: "0.5rem",
              padding: "0.65rem 1.25rem",
              fontSize: "1rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
