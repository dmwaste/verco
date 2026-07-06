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
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
