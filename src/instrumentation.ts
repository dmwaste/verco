// Next.js instrumentation hook — loads the Sentry server init and captures
// errors from Server Components, server actions, route handlers, and the proxy.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // The app server runs on Node (Coolify). Next.js middleware (src/proxy.ts)
  // runs on the edge runtime regardless, so both configs are loaded.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
