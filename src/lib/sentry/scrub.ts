import type {
  Breadcrumb,
  BreadcrumbHint,
  ErrorEvent,
  EventHint,
} from "@sentry/nextjs";

/**
 * PII scrubbing for Sentry payloads.
 *
 * Sentry stores telemetry in the US/EU, but Verco handles WA resident data on
 * behalf of local governments — that data must not leave the country. Only
 * sanitised operational telemetry (stack traces, error metadata) may cross the
 * border, never resident/council PII. These helpers run in every `beforeSend` /
 * `beforeBreadcrumb` so identifying data is stripped before an event is sent.
 *
 * Defence in depth: `sendDefaultPii: false` is also set on every `Sentry.init`,
 * and Session Replay is deliberately NOT enabled (it would record the DOM,
 * capturing on-screen names/addresses).
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// +61…, 04xx…, or any run of 8+ phone-shaped characters.
const PHONE_RE = /\+?\d[\d ()-]{7,}\d/g;

// Object keys whose values are redacted wholesale regardless of content.
const PII_KEYS = new Set([
  "first_name",
  "last_name",
  "full_name",
  "name",
  "email",
  "mobile",
  "mobile_e164",
  "phone",
  "address",
  "address_line",
  "street",
  "postcode",
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "access_token",
  "refresh_token",
]);

function redactString(value: string): string {
  return value.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[phone]");
}

/** Recursively redact PII from an arbitrary value (bounded depth). */
function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PII_KEYS.has(key.toLowerCase())
        ? "[redacted]"
        : scrubValue(val, depth + 1);
    }
    return out;
  }
  return value;
}

/** `beforeSend` — strip PII from an error event before it leaves the app. */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) {
    // Cookies + headers carry auth tokens and identifiers — drop entirely.
    delete event.request.cookies;
    delete event.request.headers;
    if (event.request.query_string) {
      event.request.query_string = redactString(String(event.request.query_string));
    }
    if (event.request.data !== undefined) {
      event.request.data = scrubValue(event.request.data);
    }
  }

  // Never send user PII — keep only a stable id if one is present.
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }

  if (event.message) event.message = redactString(event.message);

  for (const value of event.exception?.values ?? []) {
    if (value.value) value.value = redactString(value.value);
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra) as ErrorEvent["extra"];
  }
  if (event.contexts) {
    event.contexts = scrubValue(event.contexts) as ErrorEvent["contexts"];
  }

  return event;
}

/** `beforeBreadcrumb` — redact PII from breadcrumb trails. */
export function scrubBreadcrumb(
  breadcrumb: Breadcrumb,
  _hint?: BreadcrumbHint,
): Breadcrumb {
  if (breadcrumb.message) breadcrumb.message = redactString(breadcrumb.message);
  if (breadcrumb.data) {
    breadcrumb.data = scrubValue(breadcrumb.data) as Breadcrumb["data"];
  }
  return breadcrumb;
}
