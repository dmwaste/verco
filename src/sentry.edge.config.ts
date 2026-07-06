// Sentry — edge runtime init. Next.js middleware (src/proxy.ts) runs on the
// edge runtime, so this is what captures proxy errors (client resolution, auth,
// route guards — every request). Loaded by src/instrumentation.ts.
// Inert unless NEXT_PUBLIC_SENTRY_DSN is set.
import * as Sentry from "@sentry/nextjs";

import { scrubBreadcrumb, scrubEvent } from "./lib/sentry/scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_GIT_SHA,
  tracesSampleRate: 1.0, // 100% — Verco's traffic is low; dial back if volume grows
  sendDefaultPii: false,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
