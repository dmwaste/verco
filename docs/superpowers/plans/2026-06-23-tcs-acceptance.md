# T&Cs Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every booking creation on per-client Terms & Conditions acceptance, recording the accepted text + version + acceptor + channel on the booking.

**Architecture:** A per-client `terms_markdown` (+ `terms_version`) column drives the gate. The `create_booking_with_capacity_check` RPC is the single server chokepoint: it reads the client's terms, RAISEs if non-empty and not accepted, and snapshots text/version/acceptor/channel onto the booking. A `booking_resident_insert` RLS `WITH CHECK` term closes the direct-insert bypass (mirrors WS-A). Residents/staff see an acceptance modal (reusing `FaqAnswer`) before submission. Admins edit terms in a new Client config tab.

**Tech Stack:** Next.js 16, TypeScript strict, Supabase (Postgres + RLS + Edge Functions), `@base-ui/react/dialog`, react-markdown (`FaqAnswer`), Vitest + Playwright.

## Global Constraints

- Base branch is `develop`; PRs target `develop` (`gh pr create --base develop`). Verbatim from CLAUDE.md §17.
- **Two PRs, ordered.** PR-A (migration) must merge → release to `main` → prod → regen types BEFORE PR-B (consumers). Single PR redballs the Types-Freshness CI job (gens types from prod). Verbatim from spec Rollout / Eng F5.
- Never accept `unit_price_cents` from client; never set `booking.status = 'Scheduled'`; never use service role in `app/`. (CLAUDE.md Red Lines.)
- The gate's "has terms" predicate is exactly `COALESCE(btrim(terms_markdown), '') <> ''` (SQL) / `(md ?? '').trim().length > 0` (TS). Identical in every layer.
- `terms_accepted_*` are written server-side only; the caller supplies the boolean `p_terms_accepted` + the channel string. Never client-supplied text.
- Strict TS: no `any`; regenerate `src/lib/supabase/types.ts` after the migration is in prod.
- Reuse `components/faq-answer.tsx` for rendering — no `rehype-raw`, no new renderer.

---

## File Structure

**PR-A (migration only):**
- Create: `supabase/migrations/<ts>_tcs_acceptance.sql` — columns, `client_has_terms()` helper, RLS `WITH CHECK`, full `CREATE OR REPLACE create_booking_with_capacity_check`.

**PR-B (consumers):**
- Create: `supabase/functions/_shared/terms.ts` + `src/lib/booking/terms.ts` (mirror pair) — `clientHasTerms()`, `TermsAcceptanceChannel` type.
- Create: `src/app/(public)/book/confirm/terms-acceptance-dialog.tsx` — the resident/on-behalf modal.
- Create: `src/app/(admin)/admin/clients/[id]/tabs/terms-tab.tsx` — the admin editor.
- Modify: `supabase/functions/create-booking/index.ts` — pass `p_terms_accepted` + channel; map terms RAISE → 4xx.
- Modify: `src/app/(public)/book/confirm/confirm-form.tsx` — fetch `terms_markdown`; gate `onSubmit` before the `if (session)` branch.
- Modify: `src/app/(admin)/admin/properties/[id]/book/mud-booking-form.tsx` + `actions.ts` — dialog + pass flag/channel.
- Modify: `src/app/(admin)/admin/clients/[id]/client-detail.tsx` — register the Terms tab.
- Modify: `src/app/(admin)/admin/clients/actions.ts` — `updateClientTerms()`.
- Modify: `src/lib/audit/field-labels.ts` — `terms_markdown`, `terms_version` labels.
- Modify: `src/lib/supabase/types.ts` — regenerated.
- Modify: `tests/e2e/booking-flow.spec.ts` — terms-shown + no-terms cases.
- Create: `src/__tests__/terms.test.ts` — `clientHasTerms` unit tests.
- Create: `supabase/migrations` test note OR `src/__tests__/rls.test.ts` additions — RPC/RLS behaviour via rolled-back transactions.
- Modify: `scripts/sync-mirrors.sh` — register the new `terms.ts` mirror pair.

---

# PR-A — Migration

Branch: `feature/tcs-acceptance-migration` off `develop`.

### Task A1: Schema + helper + RLS + RPC migration

**Files:**
- Create: `supabase/migrations/<timestamp>_tcs_acceptance.sql` (use `pnpm supabase migration new tcs_acceptance` to get the timestamp)

**Interfaces:**
- Produces: `client.terms_markdown text`, `client.terms_version int NOT NULL DEFAULT 1`, `booking.terms_accepted_at timestamptz`, `booking.terms_accepted_text text`, `booking.terms_version int`, `booking.terms_accepted_by uuid`, `booking.terms_accepted_channel text` (CHECK in `resident_self|staff_on_behalf|mud_admin`); `client_has_terms(uuid) returns boolean`; `create_booking_with_capacity_check(... , p_terms_accepted boolean DEFAULT false, p_terms_channel text DEFAULT NULL)`.

- [ ] **Step 1: Generate the migration file**

Run: `pnpm supabase migration new tcs_acceptance`
Expected: prints a new path `supabase/migrations/<timestamp>_tcs_acceptance.sql`.

- [ ] **Step 2: Columns + helper + RLS**

Write to the new migration:

```sql
-- T&Cs acceptance gate (VER-XXX). Per-client terms, recorded on the booking.

-- 1. Per-client terms content + version
ALTER TABLE public.client
  ADD COLUMN IF NOT EXISTS terms_markdown text,
  ADD COLUMN IF NOT EXISTS terms_version  int NOT NULL DEFAULT 1;

-- 2. Acceptance record on the booking (all nullable — empty terms => skipped)
ALTER TABLE public.booking
  ADD COLUMN IF NOT EXISTS terms_accepted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS terms_accepted_text    text,
  ADD COLUMN IF NOT EXISTS terms_version          int,
  ADD COLUMN IF NOT EXISTS terms_accepted_by      uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS terms_accepted_channel text
    CHECK (terms_accepted_channel IS NULL
           OR terms_accepted_channel IN ('resident_self','staff_on_behalf','mud_admin'));

-- 3. Canonical "has terms" predicate. SECURITY DEFINER + fail-closed so RLS can
--    call it without recursing through client's own policies.
CREATE OR REPLACE FUNCTION public.client_has_terms(p_client_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT COALESCE(
    (SELECT btrim(terms_markdown) <> '' FROM public.client WHERE id = p_client_id),
    false
  );
$$;

-- 4. Close the direct-insert bypass (mirrors WS-A is_active gate). A resident/strata
--    session can INSERT directly via PostgREST, skipping the RPC; require an
--    acceptance record whenever the client has terms.
DROP POLICY IF EXISTS booking_resident_insert ON public.booking;
CREATE POLICY booking_resident_insert ON public.booking
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('resident','strata')
    AND contact_id = public.current_user_contact_id()
    AND public.collection_area_is_active(collection_area_id)
    AND (NOT public.client_has_terms(client_id) OR terms_accepted_at IS NOT NULL)
  );
```

> NOTE: copy the EXACT existing `booking_resident_insert` predicate from
> `supabase/migrations/20260622090000_ws_a_staged_go_live_gate.sql:177-183` and append
> only the final `AND (...)` line, so no existing condition is dropped. Verify the
> helper names (`current_user_role`, `current_user_contact_id`, `collection_area_is_active`)
> match that file verbatim before writing.

- [ ] **Step 3: Re-declare the RPC with the terms gate**

The RPC body cannot be ALTERed. Copy the FULL current function verbatim from
`supabase/migrations/20260622090000_ws_a_staged_go_live_gate.sql` (the
`CREATE OR REPLACE FUNCTION public.create_booking_with_capacity_check(...)` block,
its header params through `RETURN jsonb_build_object(...)`), then apply these four
deltas. Drop the old 14-arg signature first so we don't leave an overload:

```sql
DROP FUNCTION IF EXISTS public.create_booking_with_capacity_check(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, jsonb, uuid, text
);
```

Delta 1 — add two params at the END of the signature (named-arg callers unaffected):
```sql
  p_actor_id uuid DEFAULT NULL,
  p_type text DEFAULT 'Residential',
  p_terms_accepted boolean DEFAULT false,   -- NEW
  p_terms_channel text DEFAULT NULL          -- NEW
) RETURNS jsonb
```

Delta 2 — add to the `DECLARE` block:
```sql
  v_terms          text;
  v_terms_version  int;
```

Delta 3 — after the go-live `IF NOT FOUND ... END IF;` block (and before the advisory
lock), add the terms gate:
```sql
  SELECT terms_markdown, terms_version INTO v_terms, v_terms_version
  FROM public.client WHERE id = p_client_id;

  IF COALESCE(btrim(v_terms), '') <> '' AND NOT p_terms_accepted THEN
    RAISE EXCEPTION 'Terms and Conditions must be accepted before booking'
      USING ERRCODE = 'check_violation';
  END IF;
```

Delta 4 — extend the `INSERT INTO booking (...) VALUES (...)`:
```sql
  INSERT INTO booking (
    ref, status, type, property_id, contact_id, collection_area_id,
    client_id, contractor_id, fy_id, location, notes,
    terms_accepted_at, terms_accepted_text, terms_version,
    terms_accepted_by, terms_accepted_channel
  ) VALUES (
    v_ref, p_status::booking_status, p_type::booking_type,
    p_property_id, p_contact_id, p_collection_area_id,
    p_client_id, p_contractor_id, p_fy_id, p_location, p_notes,
    CASE WHEN COALESCE(btrim(v_terms),'') <> '' THEN now()           ELSE NULL END,
    CASE WHEN COALESCE(btrim(v_terms),'') <> '' THEN v_terms         ELSE NULL END,
    CASE WHEN COALESCE(btrim(v_terms),'') <> '' THEN v_terms_version ELSE NULL END,
    CASE WHEN COALESCE(btrim(v_terms),'') <> '' THEN p_actor_id      ELSE NULL END,
    CASE WHEN COALESCE(btrim(v_terms),'') <> '' THEN p_terms_channel ELSE NULL END
  )
  RETURNING id INTO v_booking_id;
```

- [ ] **Step 4: Behavioural verification (rolled-back transaction against prod)**

Do NOT apply to prod. Verify the logic in a self-rolling-back `DO` block via the
Supabase MCP `execute_sql` (the repo's `prod-rolledback-rpc-verification` pattern):
define the new function with `CREATE OR REPLACE` inside the block, call it with a
terms-enabled client + `p_terms_accepted=false` (expect RAISE), then `p_terms_accepted=true`
(expect a row with `terms_accepted_text` set), then an empty-terms client (expect NULL
terms cols), and `RAISE EXCEPTION 'rollback'` at the end. Confirm prod is untouched.

Expected: the verification RAISE reports `rejected-without-accept=OK, accepted-records-text=OK, empty-skips=OK`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/<timestamp>_tcs_acceptance.sql
git commit -m "feat(db): T&Cs acceptance gate — columns, client_has_terms, RLS, RPC (PR-A)"
```

- [ ] **Step 6: PR to develop**

```bash
git push -u origin feature/tcs-acceptance-migration
gh pr create --base develop --title "feat(db): T&Cs acceptance gate — migration (PR-A)" --body "<summary + link to spec>"
```

---

## RELEASE GATE A

PR-A must be merged to `develop`, batched to `main` by Dan, deployed, and confirmed in
prod (`/api/health` SHA), THEN regenerate types:

```bash
pnpm supabase gen types typescript --project-id tfddjmplcizfirxqhotv > src/lib/supabase/types.ts
# strip any CLI warning lines the command appends
```

Do not start PR-B's typed consumers until `types.ts` reflects the new RPC params +
booking columns. (Verbatim from spec Rollout / Eng F5.)

---

# PR-B — Consumers

Branch: `feature/tcs-acceptance-consumers` off `develop` (after Release Gate A).

### Task B1: Shared `clientHasTerms` helper + mirror

**Files:**
- Create: `supabase/functions/_shared/terms.ts`
- Create: `src/lib/booking/terms.ts`
- Create: `src/__tests__/terms.test.ts`
- Modify: `scripts/sync-mirrors.sh` (register the pair)

**Interfaces:**
- Produces: `clientHasTerms(markdown: string | null | undefined): boolean`; `type TermsAcceptanceChannel = 'resident_self' | 'staff_on_behalf' | 'mud_admin'`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/terms.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { clientHasTerms } from '@/lib/booking/terms'

describe('clientHasTerms', () => {
  it('false for null/undefined/empty/whitespace', () => {
    expect(clientHasTerms(null)).toBe(false)
    expect(clientHasTerms(undefined)).toBe(false)
    expect(clientHasTerms('')).toBe(false)
    expect(clientHasTerms('   \n\t ')).toBe(false)
  })
  it('true for real content', () => {
    expect(clientHasTerms('## Terms')).toBe(true)
    expect(clientHasTerms('  hi  ')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it, expect fail**

Run: `pnpm vitest run src/__tests__/terms.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the source-of-truth in `_shared/terms.ts`**

```ts
export type TermsAcceptanceChannel = 'resident_self' | 'staff_on_behalf' | 'mud_admin'

export function clientHasTerms(markdown: string | null | undefined): boolean {
  return (markdown ?? '').trim().length > 0
}
```

- [ ] **Step 4: Mirror to `src/lib/booking/terms.ts`**

Run: `bash scripts/sync-mirrors.sh` after registering the pair (Step 5). Or copy verbatim
(the script strips Deno `.ts` import extensions; this file has no imports so they are identical).

- [ ] **Step 5: Register the mirror in `scripts/sync-mirrors.sh`**

Add the `_shared/terms.ts` ↔ `src/lib/booking/terms.ts` pair to the script's pair list
(see existing dispatch/health/templates pairs). Then run `bash scripts/sync-mirrors.sh --check`.

- [ ] **Step 6: Run tests + commit**

Run: `pnpm vitest run src/__tests__/terms.test.ts` → PASS.
```bash
git add supabase/functions/_shared/terms.ts src/lib/booking/terms.ts src/__tests__/terms.test.ts scripts/sync-mirrors.sh
git commit -m "feat: shared clientHasTerms helper + mirror"
```

### Task B2: create-booking EF passes the flag + channel; maps RAISE → 4xx

**Files:**
- Modify: `supabase/functions/create-booking/index.ts` (the `.rpc('create_booking_with_capacity_check', {...})` call ~line 533; the error mapping ~line 552-556)

**Interfaces:**
- Consumes: request body gains `terms_accepted?: boolean`.
- Produces: passes `p_terms_accepted`, `p_terms_channel` to the RPC.

- [ ] **Step 1: Parse `terms_accepted` from the body + derive channel**

In the request zod schema add `terms_accepted: z.boolean().optional()`. Channel:
`const termsChannel = onBehalf ? 'staff_on_behalf' : 'resident_self'` (the EF already
knows on-behalf from its auth/actor branch — reuse that signal).

- [ ] **Step 2: Pass to the RPC**

Add to the `.rpc(...)` named args:
```ts
  p_terms_accepted: body.terms_accepted ?? false,
  p_terms_channel: termsChannel,
```

- [ ] **Step 3: Map the terms RAISE to a clean 4xx**

Where `Insufficient ... capacity` is mapped, add a branch: if the RPC error message
includes `Terms and Conditions must be accepted`, return HTTP 409 with
`{ error: 'Terms and Conditions must be accepted before booking' }` instead of a generic 500.

- [ ] **Step 4: Deploy + commit**

Run: `pnpm supabase functions deploy create-booking --no-verify-jwt`
```bash
git add supabase/functions/create-booking/index.ts
git commit -m "feat(ef): create-booking passes terms acceptance + maps RAISE"
```

### Task B3: createMudBooking passes flag + channel

**Files:**
- Modify: `src/app/(admin)/admin/properties/[id]/book/actions.ts` (the `CreateMudBookingInput` interface ~line 11; the `.rpc('create_booking_with_capacity_check', {...})` ~line 206)

- [ ] **Step 1: Add `terms_accepted: boolean` to `CreateMudBookingInput`.**
- [ ] **Step 2: Pass `p_terms_accepted: input.terms_accepted, p_terms_channel: 'mud_admin'` to the RPC call.**
- [ ] **Step 3: Commit**
```bash
git add src/app/(admin)/admin/properties/[id]/book/actions.ts
git commit -m "feat: createMudBooking passes terms acceptance (mud_admin channel)"
```

### Task B4: Terms acceptance dialog component

**Files:**
- Create: `src/app/(public)/book/confirm/terms-acceptance-dialog.tsx`

**Interfaces:**
- Produces: `<TermsAcceptanceDialog open termsMarkdown onAccept onCancel />` where
  `onAccept(): void` fires only when the checkbox is ticked and Accept is clicked.

- [ ] **Step 1: Build on `@base-ui/react/dialog` (follow `src/components/feedback/bug-report-dialog.tsx`)**

```tsx
'use client'
import { Dialog } from '@base-ui/react/dialog'
import { useState } from 'react'
import { FaqAnswer } from '@/components/faq-answer'
import { VercoButton } from '@/components/ui/verco-button'

export function TermsAcceptanceDialog({
  open, termsMarkdown, onAccept, onCancel,
}: {
  open: boolean
  termsMarkdown: string
  onAccept: () => void
  onCancel: () => void
}) {
  const [checked, setChecked] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) { setChecked(false); onCancel() } }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white shadow-xl">
          <Dialog.Title className="border-b border-gray-100 px-5 py-4 font-[family-name:var(--font-heading)] text-lg font-bold text-[var(--brand)]">
            Terms &amp; Conditions
          </Dialog.Title>
          <Dialog.Description className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-body-sm leading-relaxed text-gray-700">
            <FaqAnswer markdown={termsMarkdown} />
          </Dialog.Description>
          <div className="border-t border-gray-100 px-5 py-4">
            <label htmlFor="tcs-accept" className="mb-3 flex items-start gap-2.5 text-body-sm text-gray-700">
              <input id="tcs-accept" type="checkbox" checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
              <span>I have read and accept the Terms &amp; Conditions.</span>
            </label>
            <div className="flex gap-2.5">
              <VercoButton variant="secondary" className="flex-1" onClick={() => { setChecked(false); onCancel() }}>
                Cancel
              </VercoButton>
              <VercoButton className="flex-1" disabled={!checked} onClick={() => { setChecked(false); onAccept() }}>
                Accept &amp; continue
              </VercoButton>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

- [ ] **Step 2: Verify import path of `Dialog`** matches `bug-report-dialog.tsx` exactly (it may be `@base-ui-components/react/dialog` — copy whatever that file imports).
- [ ] **Step 3: Commit**
```bash
git add "src/app/(public)/book/confirm/terms-acceptance-dialog.tsx"
git commit -m "feat: terms acceptance dialog (base-ui, FaqAnswer, single checkbox)"
```

### Task B5: Wire the dialog into confirm-form (gate before the session branch)

**Files:**
- Modify: `src/app/(public)/book/confirm/confirm-form.tsx` (the `serviceName` query; the `onSubmit` handler and the `if (session)` branch ~line 583; `submitBooking` ~line 327)

**Interfaces:**
- Consumes: `terms_markdown` from the extended client query; `clientHasTerms`; `<TermsAcceptanceDialog>`.

- [ ] **Step 1: Extend the existing client query to also select `terms_markdown`**

In the `['client-service-name', collectionAreaId]` query, change the select to
`client:client_id(service_name, terms_markdown)` and return both; update the cast to
`{ service_name: string | null; terms_markdown: string | null }`. Keep `serviceName`;
add `const termsMarkdown = data?.client?.terms_markdown ?? null`. Return an object
`{ serviceName, termsMarkdown }` (rename the query var accordingly and update the
existing `serviceName` consumer in the Extra heading).

- [ ] **Step 2: Add gate state + intercept in `onSubmit` BEFORE the `if (session)` branch**

```tsx
const [showTerms, setShowTerms] = useState(false)
const [termsAccepted, setTermsAccepted] = useState(false)
const pendingSubmitRef = useRef<ContactFormData | null>(null)
```

In `onSubmit(contact)`, as the FIRST thing (before the session check), if
`clientHasTerms(termsMarkdown) && !termsAccepted`: stash `pendingSubmitRef.current = contact`,
`setShowTerms(true)`, and `return`. The Accept handler sets `termsAccepted = true`,
closes the dialog, and re-invokes the original submit path with the stashed contact.
Pass `terms_accepted: clientHasTerms(termsMarkdown)` into the create-booking body in
`submitBooking` (Task B2 reads it).

- [ ] **Step 3: Render the dialog**

```tsx
{termsMarkdown && (
  <TermsAcceptanceDialog
    open={showTerms}
    termsMarkdown={termsMarkdown}
    onCancel={() => setShowTerms(false)}
    onAccept={() => {
      setTermsAccepted(true); setShowTerms(false)
      const c = pendingSubmitRef.current
      if (c) void onSubmit(c)   // re-enter; termsAccepted now true so it passes the gate
    }}
  />
)}
```

- [ ] **Step 4: Verify in preview** — terms-enabled tenant shows the modal on Confirm; accept → proceeds; no-terms tenant unaffected. (Dev tenant VERCO Kwinana — set its `terms_markdown` in a dev/test row, or test against a seeded value.)
- [ ] **Step 5: Commit**
```bash
git add "src/app/(public)/book/confirm/confirm-form.tsx"
git commit -m "feat: gate confirm submit on T&Cs acceptance (before session branch)"
```

### Task B6: Wire the dialog into the MUD form

**Files:**
- Modify: `src/app/(admin)/admin/properties/[id]/book/mud-booking-form.tsx`

- [ ] **Step 1:** fetch the client's `terms_markdown` (the form already has the client/area context — add to its load or pass as prop from the page).
- [ ] **Step 2:** before calling `createMudBooking`, if `clientHasTerms(termsMarkdown)` show `<TermsAcceptanceDialog>`; on accept call `createMudBooking({ ...input, terms_accepted: true })`.
- [ ] **Step 3: Commit**
```bash
git add "src/app/(admin)/admin/properties/[id]/book/mud-booking-form.tsx"
git commit -m "feat: T&Cs acceptance in MUD booking form"
```

### Task B7: Admin Terms tab + updateClientTerms action + audit labels

**Files:**
- Create: `src/app/(admin)/admin/clients/[id]/tabs/terms-tab.tsx`
- Modify: `src/app/(admin)/admin/clients/[id]/client-detail.tsx` (register tab)
- Modify: `src/app/(admin)/admin/clients/actions.ts` (`updateClientTerms`)
- Modify: `src/lib/audit/field-labels.ts`

**Interfaces:**
- Produces: `updateClientTerms(clientId: string, markdown: string): Promise<Result<null>>`.

- [ ] **Step 1: `updateClientTerms` action** — mirror `updateClientFaqs` EXACTLY incl. the
  `.update({ terms_markdown: trimmed || null, terms_version: <current+1> }).eq('id', clientId).select('id').single()`
  silent-fail guard. Trim input; whitespace-only → store NULL. Bump `terms_version` only
  when the text actually changes (read current first; if unchanged, skip the bump).
- [ ] **Step 2: Terms tab** — single `<textarea>` + live `<FaqAnswer>` preview + Save
  (copy the FAQs tab's `saving/error/saved` states). When empty, show a warning banner:
  "No Terms configured — residents will book without a consent step." (spec Design F6 / CEO F3.)
  Add a note: "Terms entered here are the council's; Verco captures acceptance only." (Compliance.)
- [ ] **Step 3: Register the tab** in `client-detail.tsx` (follow the existing FAQs tab registration).
- [ ] **Step 4: Audit labels** — add to `lib/audit/field-labels.ts` client block:
  `terms_markdown: 'Terms & Conditions', terms_version: 'Terms Version'`.
- [ ] **Step 5: Commit**
```bash
git add "src/app/(admin)/admin/clients/[id]/tabs/terms-tab.tsx" "src/app/(admin)/admin/clients/[id]/client-detail.tsx" "src/app/(admin)/admin/clients/actions.ts" src/lib/audit/field-labels.ts
git commit -m "feat(admin): Terms & Conditions tab + updateClientTerms + audit labels"
```

### Task B8: RPC/RLS behaviour tests (rolled-back transactions)

**Files:**
- Modify: `src/__tests__/rls.test.ts` (or a new `src/__tests__/terms-rpc.test.ts` following the same BEGIN/impersonate/ROLLBACK pattern)

- [ ] **Step 1: Add cases** (each in its own savepoint, asserting then rolling back):
  1. terms set + `p_terms_accepted` omitted (DEFAULT) ⇒ RPC RAISEs (`check_violation`).
  2. terms set + `p_terms_accepted=true` ⇒ booking row has `terms_accepted_at` set,
     `terms_accepted_text` == client's `terms_markdown`, `terms_version` == client's version,
     `terms_accepted_channel` == passed channel.
  3. empty terms ⇒ booking created, all `terms_*` NULL regardless of the flag.
  4. whitespace-only terms ⇒ treated as empty (case 3 behaviour).
  5. direct PostgREST INSERT as an impersonated resident into a terms-enabled client with
     `terms_accepted_at = NULL` ⇒ DENIED by `booking_resident_insert` RLS.
- [ ] **Step 2: Run** `pnpm vitest run src/__tests__/terms-rpc.test.ts` → PASS.
- [ ] **Step 3: Commit**
```bash
git add src/__tests__/terms-rpc.test.ts
git commit -m "test: T&Cs RPC gate + RLS bypass coverage"
```

### Task B9: E2E + types + open PR-B

**Files:**
- Modify: `tests/e2e/booking-flow.spec.ts`
- Modify: `src/lib/supabase/types.ts` (already regenerated at Release Gate A; confirm it's committed)

- [ ] **Step 1: E2E — terms-shown case.** In the mock's client branch, return
  `terms_markdown: '## Terms\nYou agree.'`; assert the T&Cs modal appears on Confirm,
  the checkbox gates Accept, and booking proceeds after accept.
- [ ] **Step 2: E2E — no-terms case.** Mock returns `terms_markdown: null`; assert no modal,
  booking proceeds (regression guard).
- [ ] **Step 3: Run** `pnpm test:e2e` (note: E2E only runs on base==main PRs; still run locally) and `pnpm tsc --noEmit`.
- [ ] **Step 4: Commit + PR**
```bash
git add tests/e2e/booking-flow.spec.ts src/lib/supabase/types.ts
git commit -m "test(e2e): T&Cs modal shown/hidden cases"
git push -u origin feature/tcs-acceptance-consumers
gh pr create --base develop --title "feat: T&Cs acceptance — consumers (PR-B)" --body "<summary; depends on PR-A in prod>"
```

---

## Self-Review notes

- **Spec coverage:** data model (A1) ✓; RPC chokepoint + RAISE (A1) ✓; RLS bypass (A1) ✓;
  shared predicate (B1) ✓; EF (B2) ✓; MUD (B3) ✓; resident dialog incl. gate-before-session
  + state machine (B4/B5) ✓; admin tab + empty-state + compliance note (B7) ✓; acceptor +
  channel + version (A1 cols, B2/B3 channel, B7 version bump) ✓; tests incl. bypass +
  whitespace + omitted-flag (B8) + E2E (B9) ✓; PR split (Release Gate A) ✓.
- **Deferred (per spec):** scroll-gate (D3 = single checkbox), council-URL (D4 = markdown),
  per-sub-client override, ID-intake, versioned-history table — not built.
- **Loading/error states (Design F1):** the modal only renders when `termsMarkdown` is
  truthy; while the client query is in-flight `termsMarkdown` is null so the gate is not
  yet armed — Task B5 must NOT let submit proceed while the query is still loading for a
  client that turns out to have terms. Implementer note in B5: if the client query
  `isLoading`, the Confirm button shows the existing `isSubmitting`/disabled state until it
  resolves (do not fire submit on an unresolved terms state). The RPC is the fail-closed
  backstop regardless.
