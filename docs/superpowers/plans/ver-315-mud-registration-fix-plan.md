<!-- /autoplan restore point: /Users/danieltaylor/.gstack/projects/dmwaste-verco/claude-ver-315-implementation-plan-812392-autoplan-restore-20260709-093110.md -->
# VER-315 — Fix MUD registration form: remove 8-unit minimum, accept landline phones

**Linear:** [VER-315](https://linear.app/verco/issue/VER-315) · Priority: **Urgent** · Project: UAT Bugs
**Branch base:** `develop` · **Type:** UAT bug fix (admin UI validation)

---

## 1. Problem

Reported against a live Kwinana MUD (multi-unit dwelling) property. Three blocking symptoms:

1. Can't complete bookings for the MUD unless it is re-registered.
2. The unit-count field rejects any value under 8 — small complexes can't be registered.
3. The phone field only accepts AU mobile format (`04XX` / `+614XX`) — strata managers commonly provide business landlines.

Symptoms 2 and 3 are the causes; symptom 1 is a downstream consequence: a MUD that can't be
saved/registered can't be booked.

## 2. Root cause (verified against code)

The MUD registration/edit UI applies two client-side validation rules that are **stricter than
both the business requirement and the server layer**.

**Unit-count minimum 8** — hard-coded as a blocking guard in both forms:
- `set-mud-modal.tsx` — default `useState(8)` (L37), reset `setUnitCount(8)` (L54), guard `unitCount < 8` (L121), input `min={8}` (L224), hint "Minimum 8" (L229)
- `mud-edit-form.tsx` — guard `unitCount < 8` (L106), input `min={8}` (L186)

The authoritative gate `canMarkRegistered()` (`src/lib/mud/state-machine.ts:83`) only requires
`unit_count >= 1` (0 = "not yet recorded"). No DB constraint enforces 8. Any MUD with 1–7 units is
permanently unregisterable from the UI.

**Mobile-only phone validation** — the same regex is **triplicated**:
- `set-mud-modal.tsx:31` — `const auMobileRegex = /^(\+614\d{8}|04\d{8})$/`, applied at L140
- `mud-edit-form.tsx:36` — identical const, applied at L124
- `src/lib/mud/validation.ts:18` — identical const, used by `strataContactSchema` (L31)

The live server validator (`src/app/(admin)/admin/properties/actions.ts:31`) is
`mobile_e164: z.string().trim().min(6).max(20)` — it already accepts landlines. The client is
simply stricter than its own server.

### Review findings (things the ticket got slightly wrong or missed)

- **Ticket miss (important):** the ticket lists `useState(8)` at L37 but not the `useEffect`
  reset `setUnitCount(8)` at **L54**. Change only L37 and the field snaps back to 8 on every modal
  open — the bug would look unfixed. **Both must change.**
- **Dead code:** `validation.ts`'s `strataContactSchema`, `auMobileRegex`, and the
  `mudProperty*Schema`s are **not imported anywhere at runtime** — only `COLLECTION_CADENCES` is
  consumed from that file. So editing them is hygiene/consistency, not a functional fix. The runtime
  path is the two inline `.tsx` regexes + `actions.ts`'s own (already-lenient) schema.
- **AC subtlety:** acceptance criteria require `(08) 9123 4567` (brackets + spaces) to save. A
  digit-strict regex rejects that unless non-digits are stripped first.
- **Blast radius is exactly 3 files + a new test.** No strata self-service form exists (deferred).
  `mud-status-actions.tsx` (the promote-to-Registered button) already keys off `canMarkRegistered`
  and needs no change.

## 3. Approach

Two options considered.

- **Approach A (literal):** loosen the regex + unit guard in place in each of the 3 files. Minimal
  diff, but leaves 3 copies of the phone rule and no unit-testable surface (inline `.tsx` regexes
  can't be unit-tested).
- **Approach B (consolidate) — RECOMMENDED:** make `validation.ts` the single source of truth (its
  own docstring already claims to be "a single source of error messages"), export phone helpers,
  import them into both forms, delete the two inline copies, and add a unit test. Barely larger than
  A — it *deletes* two inline consts — and kills the triplication that caused the drift.

The root cause is not "the regex is wrong", it is that the rule is **triplicated and drifted apart
from the server**. B fixes the cause; A fixes one instance. B is recommended.

## 4. Implementation (Approach B)

### 4.1 `src/lib/mud/validation.ts` — client-side validity helper (revised per Eng review F1/F2)

The mobile-only `auMobileRegex` is the bug. The fix is NOT a new, narrower AU regex — that would
still reject the numbers strata managers actually use (`1300`/`1800`/`13xx` service lines, bare
8-digit locals like `9123 4567`, international) and would *still* be stricter than the server. Make the
client accept every real phone format, rejecting only non-numeric junk:

```ts
// Accepts mobile / landline / 1300 / 1800 / 13xx / international. Rejects letters + too-short.
// Client-side friendly-feedback gate only; server (actions.ts) stays min(6).max(20) authoritative.
export const normalisePhone = (s: string) => s.replace(/[\s()\-.]/g, '')      // strip formatting
export function isValidPhone(s: string): boolean {
  return /^\+?\d{6,15}$/.test(normalisePhone(s.trim()))    // 6–15 digits, optional leading +
}
```

Also **delete the now-superseded `auMobileRegex` (L18)** and point `validation.ts`'s (runtime-dead)
`strataContactSchema.mobile_e164` at `.refine(isValidPhone, …)` so the file has one phone concept and
no orphaned const (`noUnusedLocals` is OFF, so an orphan would linger silently — Eng Q5).

**Add `isSmsCapable` (D2 = wire chosen):** the hint is wired into both forms (§4.2/§4.3), so it's not
dead code.

```ts
// SMS-capable = AU mobile only. Drives the "won't receive SMS" hint.
export const isSmsCapable = (s: string) => /^(\+?61|0)4\d{8}$/.test(normalisePhone(s.trim()))
```

### 4.1a `src/app/(admin)/admin/properties/actions.ts` — canonicalise mobiles on store (Eng F1/F2)

This is where the real correctness fix lives. Strata mobiles feed NCN dual-recipient SMS
(`dispatch.ts:550` sends `to: contact.mobile_e164` **verbatim**; Twilio needs E.164 `+61…`). Storing a
national `0412345678` breaks that. The resident flow already solves this with the tested
`normaliseAuMobile()` (`src/lib/booking/schemas.ts:22`, `04…`→`+61…`, else `null`).

- `strataContactSchema.mobile_e164`: keep `.min(6).max(20)` (do NOT add an `isValidPhone` refine here —
  it would *tighten* the server and could reject legacy extension-format contacts on re-save, Eng Q4).
  Add `.transform(v => normaliseAuMobile(v) ?? normalisePhone(v))` — mobiles → E.164 (SMS-safe),
  landlines/1300 → formatting-stripped (they never SMS). One write-path authority; every caller of the
  `upsertStrataContact` server action gets a clean value, not just the two forms (Eng F2).
- Import `normaliseAuMobile` from `@/lib/booking/schemas`, `normalisePhone` from `@/lib/mud/validation`.

### 4.2 `src/app/(admin)/admin/properties/set-mud-modal.tsx`

- L37 `useState(8)` → `useState(1)`
- **L54 `setUnitCount(8)` → `setUnitCount(1)`** (the reset the ticket missed)
- L121 `if (unitCount < 8)` → `if (unitCount < 1)`; message → "Unit count must be at least 1."
- L224 `min={8}` → `min={1}`; L229 hint "Minimum 8" → "Minimum 1"
- Delete inline `auMobileRegex` (L31); replace guard L140 with `if (!isValidPhone(contactMobile))`,
  message "Enter a valid phone number."; import `isValidPhone`
- L314 placeholder "Mobile (04XX or +614XX)" → "Phone (mobile or landline)"
- **SMS hint (D2):** when `contactMobile` is non-empty and `!isSmsCapable(contactMobile)`, render a
  caption under the phone input: "Landline entered — this contact won't receive SMS notices, only email."
  (existing `text-caption text-gray-400` style per CLAUDE.md §21)
- **No client-side normalisation** — the server action owns canonicalisation (§4.1a), smaller `.tsx` diff

### 4.3 `src/app/(admin)/admin/properties/[id]/mud-edit-form.tsx`

- L106 `if (unitCount < 8)` → `if (unitCount < 1)`; message updated
- L186 `min={8}` → `min={1}`
- Delete inline `auMobileRegex` (L36); replace guard L124 with `isValidPhone`; import it (+ `isSmsCapable`)
- L266 placeholder → "Phone (mobile or landline)"
- **SMS hint (D2):** same non-mobile caption as §4.2 under the phone input
- No default/reset change (seeded from `property.unit_count`); no client-side normalisation

### 4.4 New test `src/__tests__/mud-validation.test.ts`

Encodes the ACs + the review-surfaced cases so this can't regress:
- `isValidPhone` ACCEPTS: `0412345678` (mobile), `08 91234567` + `(08) 9123 4567` (landline formatted),
  `9123 4567` (bare local), `1300 975 707` + `1800123456` (service lines), `+61891234567` (international)
- `isValidPhone` REJECTS: `abc`, `12345` (too short), empty
- `normalisePhone('(08) 9123 4567') === '0891234567'`; `normalisePhone('+61 412 345 678') === '+61412345678'` (Eng LOW: `+` preservation)
- `isSmsCapable` (D2): true for `0412345678` / `+61412345678`; false for the landline + `1300 975 707`
- Canonicalisation (via the server transform behaviour): `normaliseAuMobile('0412 345 678') === '+61412345678'`; landline → `null` → falls back to stripped `0891234567`
- **Untested-by-design (named, Eng Q3):** the two form guards' `unit_count < 1` and the L54 reset live
  inline in `.tsx` and are covered only by the manual preview drive, not a unit test.

## 5. Verify → ship

- **Belt-and-braces on premise (CEO F1, user-settled downstream-only):** before/while coding, pull the
  reported Kwinana MUD row (`unit_count`, `mud_onboarding_status`, strata `mobile_e164`) via service-role
  query and confirm the validators are what block it. Cheap confirmation that closing this ticket
  actually unblocks the operator — no code scope added.
- `pnpm test` (new + existing green) and `pnpm build` (typecheck catches the deleted-const import wiring)
- Drive both forms in preview: save a 3-unit MUD with `(08) 9123 4567`; save one with a `1300` number;
  save one with a mobile; confirm 0/negative still rejected; confirm promote-to-Registered now succeeds
- Branch off `develop`, PR → `develop` (per CLAUDE.md §17), reference VER-315

## 6. Acceptance criteria (from the ticket)

- [ ] A MUD with `unit_count = 3` (any 1–7) can be saved and promoted to Registered
- [ ] A strata contact with an AU landline (`08 91234567` / `(08) 9123 4567`) saves via both the Set
  MUD modal and the Edit form without error
- [ ] A valid AU mobile still saves correctly
- [ ] The unit-count field still rejects 0 and negatives
- [ ] `actions.ts` schema still passes for both mobile and landline (already does — confirm no regression)
- [ ] Existing Registered MUDs with mobile numbers are unaffected

## 7. Not in scope (kept out deliberately)

- **No backfill of existing `mobile_e164` rows** — new/edited strata mobiles canonicalise to `+61…`
  E.164 on store (§4.1a, reusing `normaliseAuMobile`); landlines/1300 store formatting-stripped. Existing
  rows are left as-is (a one-off backfill of legacy national-format mobiles is separate scope).
- **No DB migration** — `contacts.mobile_e164` is unconstrained `text`; the server already accepts
  landline strings.
- **No strata self-service form** — doesn't exist yet (deferred per product scope).
- **No E2E test** — admin-only flow; the unit test on the extracted helper + a preview drive is the
  proportionate gate for a UAT bug fix. (Existing E2E suite is booking-flow focused.)
- **Deferred to TODOS (CEO expansion scan):** apply `isValidPhone` to the resident booking contact form
  (same anti-pattern, out of this ticket's blast radius); backfill/repair any MUDs stuck at Contact Made
  by this bug (operational).

## 7a. Open confirmation (CEO F4 — non-blocking)

The ticket (Dan-authored) asserts the 8-unit floor is an arbitrary early assumption with no PRD/DB
basis, and AC#1 requires a 3-unit MUD to register. The CEO review flagged that `useState(8)` + `min={8}`
+ "Minimum 8" are three deliberate-looking signals, so **one line to Ben** to confirm 8 isn't a real
Kwinana/WMRC MUD threshold before deleting it. Low risk (ticket author already decided); belt-and-braces.

## 8. Risk / impact

- Loosening client validation cannot bypass server/RLS/DB constraints (defence-in-depth intact).
- A landline/1300 stored in `contacts.mobile_e164` (now formatting-stripped) simply receives no SMS; the
  notification layer tolerates a per-channel skip (email still sends) — memory `feedback-multi-channel-idempotency.md`.
- Making the client mirror the server's leniency means the client no longer rejects any real phone
  format; the light `isValidPhone` digits-check still catches typo'd non-numbers before store.
- Net effect: any MUD with 1–7 units or a landline/1300 contact can reach **Registered** and become
  bookable, resolving the "can't complete bookings" symptom.

## 9. What already exists (reused, not rebuilt)

- `canMarkRegistered()` (`state-machine.ts:83`) — the authoritative `unit_count >= 1` gate. Reused.
- `actions.ts` `strataContactSchema` — the live server validator (`min(6).max(20)`). Extended, not replaced.
- `normaliseAuMobile()` (`booking/schemas.ts:22`) — tested `04…`/`61…`→`+61…` E.164 canonicaliser used by
  the resident flow. **Reused** for the strata store path (Eng F1) instead of a new parallel helper.

## 10. Failure modes registry

```
  CODEPATH                          | FAILURE MODE                 | RESCUED? | TEST? | USER SEES                 | LOGGED
  ----------------------------------|------------------------------|----------|-------|---------------------------|-------
  isValidPhone(junk)                | letters / too short          | Y (form) | Y     | "Enter a valid phone…"    | n/a
  server transform, landline input  | normaliseAuMobile → null     | Y        | Y     | stored formatting-stripped| n/a
  server transform, mobile input    | canonicalised to +61…        | Y        | Y     | stored E.164 (SMS works)  | n/a
  unit guard, 0 / negative / NaN    | rejected before RPC          | Y (form) | manual| "Unit count must be ≥ 1"  | n/a
```
No row is RESCUED=N / TEST=N / SILENT → **no critical gaps.** (The unit-guard TEST=manual is the named
Eng Q3 residual, accepted for a UAT fix.)

## 11. Decision audit trail (autoplan)

| # | Phase | Decision | Class | Principle | Rejected |
|---|-------|----------|-------|-----------|----------|
| 1 | CEO 0C-bis | Approach **B** (shared helper + unit test) | taste→auto | P4/P5 | A literal in-place |
| 2 | CEO F1 | Booking symptom = downstream-only; no booking-path investigation | user-settled (D1) | — | scope investigation |
| 3 | CEO F2 | Client `isValidPhone` accepts 1300/1800/bare-local/intl | auto (correctness) | P1 | narrow AU regex |
| 4 | Eng F1 | Canonicalise mobiles → E.164 on store via existing `normaliseAuMobile` | auto (correctness) | P4 | strip-only normalise |
| 5 | Eng F2 | Normalise in the **server action**, not client call sites | auto | P5 | client-side normalise |
| 6 | Eng Q4 | Do NOT add `isValidPhone` refine to server schema | auto | P3 | tighten both layers |
| 7 | Eng Q5 | Delete orphaned `auMobileRegex` L18 + rewire dead schema | auto | P5 | leave dead block |
| 8 | Eng Q5 | `isSmsCapable`/SMS-hint → **D2 = WIRE** (Dan chose) | taste (resolved) | P1 | drop the hint |
| 9 | CEO F4 | Remove 8-unit floor; one-line confirm w/ Ben (non-blocking) | auto+flag | P6 | keep floor / block |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` (via `/autoplan`) | Scope & strategy | 1 | issues_open | 5 findings (F1–F5); premise gate settled |
| Eng Review | `/plan-eng-review` (via `/autoplan`) | Architecture & tests | 1 | issues_open | F1+F2 medium (verified in code), 5 low |
| Design Review | inline (no new UI surface) | UI/UX | 1 | clean | ~8/10; 1 enhancement (SMS hint) |
| DX Review | — | Dev experience | 0 | — | skipped (no developer-facing scope) |
| Outside Voice (Codex) | `/codex` | Independent 2nd opinion | 0 | unavailable | Codex usage-limited all phases |

- **CROSS-MODEL:** unavailable — Codex rate-limited (resets Aug 5); all outside voices ran as Claude subagents (`subagent-only`).
- **CROSS-PHASE THEME:** phone-validation correctness flagged **independently** by CEO (F2: narrow regex rejects real numbers) *and* Eng (F1: national store breaks SMS) → high-confidence; both folded into §4.1/§4.1a.
- **VERDICT:** APPROVED at the final gate. D2 = wire the SMS hint. F4 (confirm 8-unit with Ben) is a
  non-blocking parallel check. Plan-stage review complete; a diff-stage `/review` still applies before ship.

NO UNRESOLVED DECISIONS
