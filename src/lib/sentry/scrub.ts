import type {
  Breadcrumb,
  BreadcrumbHint,
  BrowserOptions,
  ErrorEvent,
  EventHint,
} from "@sentry/nextjs";

// `@sentry/nextjs` doesn't re-export core's TransactionEvent; take it from the hook.
export type TransactionEvent = Parameters<
  NonNullable<BrowserOptions["beforeSendTransaction"]>
>[0];
type SentryRequest = NonNullable<ErrorEvent["request"]>;

/**
 * PII scrubbing for Sentry payloads.
 *
 * Sentry stores telemetry in the US/EU, but Verco handles WA resident data on
 * behalf of local governments — that data must not leave the country. Only
 * sanitised operational telemetry (stack traces, error metadata) may cross the
 * border, never resident/council PII. These helpers run in every `beforeSend` /
 * `beforeSendTransaction` / `beforeBreadcrumb` so identifying data is stripped
 * before an event is sent.
 *
 * Defence in depth: `sendDefaultPii: false` is also set on every `Sentry.init`,
 * and Session Replay is deliberately NOT enabled (it would record the DOM,
 * capturing on-screen names/addresses).
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// A real calendar date, not followed by another digit or hyphen, so a phone
// grouped like `0412-34-5678` or `0894-11-1234` isn't mistaken for one.
const DATE = "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])";
const ISO_DATE = `${DATE}(?:T[\\d:.]+(?:Z|[+-]\\d{2}:?\\d{2})?)?(?![\\d-])`;
// +61…, 04xx…, or any run of 8+ phone-shaped characters. UUIDs and ISO dates
// are matched first (group 1) and kept, so their digit runs aren't read as
// phone numbers (ids arrived as `xxxxxxxx-[phone]-…`).
const PHONE_RE = new RegExp(`(${UUID}|${ISO_DATE})|\\+?\\d[\\d ()-]{7,}\\d`, "gi");

// URL query values are default-deny: only id-, number-, date- and flag-shaped
// values stay readable, whatever the param is called. The booking wizard
// carries the address (and, on a staff edit, name/email/mobile/notes) in its
// query string, and a list of PII param names would miss the next one added.
const QUERY_PAIR_RE = /([?&])([^=&#\s?]+)=([^&#\s]*)/g;
const SAFE_QUERY_VALUE_RE = new RegExp(
  `^(?:${UUID}(?::\\d{1,3})?(?:,${UUID}(?::\\d{1,3})?)*|\\d{1,6}|${DATE}|true|false)?$`,
  "i",
);
// Keys whose string value is a bare query string (no leading `?`).
const QUERY_KEYS = new Set(["query_string", "url.query", "http.query"]);

// Sentry builds ui.* breadcrumb messages from the clicked element and copies
// its aria-label / title / alt values in: free text, e.g. a table cell's
// `title={address}`. Matched to end of string too, in case the message was
// truncated before the closing `"]`. Code-defined `type` / `name` stay.
const UI_ATTR_TEXT_RE = /\[(aria-label|title|alt)="[\s\S]*?(?:"\]|$)/g;

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

function safeQueryValue(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return "[redacted]";
  }
  return SAFE_QUERY_VALUE_RE.test(decoded) ? raw : "[redacted]";
}

function redactQueryValues(value: string): string {
  return value.replace(
    QUERY_PAIR_RE,
    (_match, sep: string, name: string, raw: string) =>
      `${sep}${name}=${safeQueryValue(raw)}`,
  );
}

/** A bare query string (`a=1&b=2`, with or without the leading `?`). */
function redactQueryString(value: string): string {
  if (value.startsWith("?")) return redactString(value);
  return redactString(`?${value}`).slice(1);
}

function redactString(value: string): string {
  return redactQueryValues(value.replace(EMAIL_RE, "[email]")).replace(
    PHONE_RE,
    (match, keep: string | undefined) => (keep ? match : "[phone]"),
  );
}

/** Recursively redact PII from an arbitrary value (bounded depth). */
function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      out[key] = PII_KEYS.has(lower)
        ? "[redacted]"
        : QUERY_KEYS.has(lower) && typeof val === "string"
          ? redactQueryString(val)
          : scrubValue(val, depth + 1);
    }
    return out;
  }
  return value;
}

function scrubQueryParams(
  query: NonNullable<SentryRequest["query_string"]>,
): SentryRequest["query_string"] {
  if (typeof query === "string") return redactQueryString(query);
  if (Array.isArray(query)) {
    return query.map(([key, val]): [string, string] => [key, safeQueryValue(val)]);
  }
  return Object.fromEntries(
    Object.entries(query).map(([key, val]) => [key, safeQueryValue(val)]),
  );
}

function scrubRequest(request: SentryRequest): void {
  // Cookies + headers carry auth tokens and identifiers (the Referer header
  // carries the previous page's full URL) — drop entirely.
  delete request.cookies;
  delete request.headers;
  // The browser SDK sets url = location.href, query string included.
  if (request.url) request.url = redactString(request.url);
  if (request.query_string) {
    request.query_string = scrubQueryParams(request.query_string);
  }
  if (request.data !== undefined) {
    request.data = scrubValue(request.data);
  }
}

/** `beforeSend` — strip PII from an error event before it leaves the app. */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) scrubRequest(event.request);

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

/**
 * `beforeSendTransaction` — the same scrub for performance events. With
 * tracing at 100% every page view sends one, and its request and spans carry
 * full URLs (`url`, `http.url`, `http.query`, `url.query`, `url.full`).
 */
export function scrubTransaction(
  event: TransactionEvent,
  _hint: EventHint,
): TransactionEvent {
  if (event.request) scrubRequest(event.request);
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : {};
  }
  if (event.transaction) event.transaction = redactString(event.transaction);
  if (event.extra) {
    event.extra = scrubValue(event.extra) as TransactionEvent["extra"];
  }
  if (event.contexts) {
    event.contexts = scrubValue(event.contexts) as TransactionEvent["contexts"];
  }
  for (const span of event.spans ?? []) {
    if (span.description) span.description = redactString(span.description);
    if (span.data) span.data = scrubValue(span.data) as typeof span.data;
  }
  return event;
}

/** `beforeBreadcrumb` — redact PII from breadcrumb trails. */
export function scrubBreadcrumb(
  breadcrumb: Breadcrumb,
  _hint?: BreadcrumbHint,
): Breadcrumb {
  if (breadcrumb.message) {
    const message = breadcrumb.category?.startsWith("ui.")
      ? breadcrumb.message.replace(UI_ATTR_TEXT_RE, '[$1="[redacted]"]')
      : breadcrumb.message;
    breadcrumb.message = redactString(message);
  }
  if (breadcrumb.data) {
    breadcrumb.data = scrubValue(breadcrumb.data) as Breadcrumb["data"];
  }
  return breadcrumb;
}
