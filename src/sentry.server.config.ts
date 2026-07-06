// Sentry — server (Node runtime) init. Loaded by src/instrumentation.ts.
// Inert unless NEXT_PUBLIC_SENTRY_DSN is set (see .env.example).
import * as Sentry from "@sentry/nextjs";

import { scrubBreadcrumb, scrubEvent } from "./lib/sentry/scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  environment: process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_GIT_SHA,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  sendDefaultPii: false,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
