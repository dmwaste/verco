// Sentry — browser init. Next.js loads this on the client automatically.
// Inert unless NEXT_PUBLIC_SENTRY_DSN is set (baked at build — see .env.example).
import * as Sentry from "@sentry/nextjs";

import { scrubBreadcrumb, scrubEvent } from "./lib/sentry/scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_GIT_SHA,
  tracesSampleRate: 1.0, // 100% — Verco's traffic is low; dial back if volume grows
  // Session Replay is deliberately NOT enabled: it records the DOM, which on a
  // resident-facing PII app would capture names/addresses on screen. Do not add
  // replayIntegration without a masking review.
  sendDefaultPii: false,
  // Known-benign client noise — none of these indicate a Verco defect:
  // supabase-js cross-tab auth-token lock contention (the winning tab refreshed
  // fine), browser-extension messaging, and iOS in-app WebView chatter.
  // The lock patterns are anchored to the two exact messages auth-js 2.100.0
  // throws for benign race-loss (locks.js:156 "immediately failed",
  // locks.js:243 "stole it") — deliberately NOT a bare prefix, so any future
  // lock-acquisition *timeout* variant (a real auth-availability signal, the
  // "field crews bumped out" symptom class) still reaches Sentry.
  ignoreErrors: [
    /Lock "lock:sb-.+-auth-token" was released because another request stole it/,
    /Acquiring an exclusive Navigator LockManager lock "lock:sb-.+ immediately failed/,
    "Invalid call to runtime.sendMessage(). Tab not found.",
    "WKWebView API client did not respond to this postMessage",
  ],
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
