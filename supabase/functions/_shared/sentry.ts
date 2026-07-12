// Sentry for Supabase Edge Functions (Deno).
//
// INERT unless the `SENTRY_DSN` secret is set (`supabase secrets set SENTRY_DSN=…`).
// With no DSN, `withSentry` returns the handler unchanged — zero behaviour change,
// zero overhead. Every Sentry call is wrapped so it can NEVER break an Edge
// Function (this includes the money path: create-booking / create-checkout /
// stripe-webhook).
//
// Follows Supabase's guide: `defaultIntegrations: false` to avoid scope pollution
// across reused runtimes. PII is scrubbed before send — Sentry stores telemetry
// in the EU, and council resident data must not leave Australia. Mirrors the
// Next.js scrubber (src/lib/sentry/scrub.ts).
import * as Sentry from "https://esm.sh/@sentry/deno@8?target=deno";
import type { ErrorEvent, EventHint } from "https://esm.sh/@sentry/deno@8?target=deno";

// ── PII scrubbing (mirror of src/lib/sentry/scrub.ts) ──
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d ()-]{7,}\d/g;
const PII_KEYS = new Set([
  "first_name", "last_name", "full_name", "name",
  "email", "mobile", "mobile_e164", "phone",
  "address", "address_line", "street", "postcode",
  "authorization", "cookie", "set-cookie", "token", "access_token", "refresh_token",
]);

function redactString(value: string): string {
  return value.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEYS.has(k.toLowerCase()) ? "[redacted]" : scrubValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.headers;
    if (event.request.query_string) {
      event.request.query_string = redactString(String(event.request.query_string));
    }
    if (event.request.data !== undefined) {
      event.request.data = scrubValue(event.request.data);
    }
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  if (event.message) event.message = redactString(event.message);
  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactString(value.value);
  }
  if (event.extra) event.extra = scrubValue(event.extra) as ErrorEvent["extra"];
  if (event.contexts) event.contexts = scrubValue(event.contexts) as ErrorEvent["contexts"];
  return event;
}

// ── init (once, at module load) ──
const DSN = Deno.env.get("SENTRY_DSN");
export const SENTRY_ENABLED = Boolean(DSN);

if (SENTRY_ENABLED) {
  try {
    Sentry.init({
      dsn: DSN,
      environment: Deno.env.get("SENTRY_ENVIRONMENT") ?? "edge-functions",
      defaultIntegrations: false,
      tracesSampleRate: 1.0,
      sendDefaultPii: false,
      beforeSend: scrubEvent,
    });
  } catch (_e) {
    // Never let Sentry init break an Edge Function.
  }
}

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Wrap an Edge Function handler with Sentry: measures duration as a span and
 * captures exceptions, then flushes before the response returns (EF runtimes
 * freeze after responding). Inert + zero-overhead when SENTRY_DSN is unset —
 * returns the handler unchanged. Preserves the handler's behaviour exactly
 * (errors are captured and re-thrown, not swallowed).
 */
export function withSentry(name: string, handler: Handler): Handler {
  if (!SENTRY_ENABLED) return handler;
  return async (req: Request): Promise<Response> => {
    return await Sentry.startSpan(
      { name, op: "function.edge" },
      async () => {
        try {
          return await handler(req);
        } catch (e) {
          Sentry.captureException(e);
          throw e;
        } finally {
          try {
            await Sentry.flush(2000);
          } catch (_e) {
            // ignore flush failures
          }
        }
      },
    );
  };
}

/**
 * Capture a non-fatal WARNING to Sentry — for a code path that does not throw but
 * still needs a human's eyes (e.g. a money-path event the EF deliberately parks
 * for manual reconciliation). `withSentry` only captures thrown exceptions, so a
 * silent `return` inside a handler would otherwise leave `console.log` as the only
 * signal.
 *
 * Inert + zero-overhead when SENTRY_DSN is unset, and — like `withSentry` — can
 * NEVER throw, so an observability call can't break a money-path EF. The event
 * runs through `beforeSend`/`scrubEvent` (message + extra are PII-scrubbed), but
 * pass only non-PII structured context (ids, amounts) — the scrubber is a
 * backstop, not a licence to send contact fields.
 *
 * Sent under the withSentry span when one is active; `withSentry`'s `flush`
 * covers delivery before the runtime freezes.
 */
export function captureWarning(message: string, extra?: Record<string, unknown>): void {
  if (!SENTRY_ENABLED) return;
  try {
    Sentry.captureMessage(message, { level: "warning", extra });
  } catch (_e) {
    // Never let a warning capture break an Edge Function.
  }
}
