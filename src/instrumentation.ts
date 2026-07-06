// Next.js instrumentation hook — loads the Sentry server init and captures
// errors from Server Components, server actions, route handlers, and the proxy.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Coolify runs the app on the Node runtime only — no edge runtime (CLAUDE.md §2).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
