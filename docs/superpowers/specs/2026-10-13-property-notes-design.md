# Property notes & documents (permission-to-enter forms) — design

_Approved by Dan 13/10/2026. Migration `20261013180000_property_notes.sql` was dry-run on prod in a rolled-back transaction: 37 role and tenant checks passed._

## Context

Staff have nowhere in Verco to keep a resident's signed **permission-to-enter form** (the owner's OK for crews to collect from behind a gate, down a driveway or along a private road). The form ends up in email or on paper, so nobody can find it when a council asks or a booking is disputed. This feature stores notes and documents against an eligible property.

**Why (PR line):** keeps a resident's signed permission-to-enter form with their property, and only D&M staff and that council's staff can see it. It protects resident PII and the indemnity record.

**Decisions from Dan (13/10/2026):**
- **Who can see them:** D&M office staff and council staff only. Crews, rangers and residents never see them, which also keeps the field/ranger zero-PII rule intact.
- **Use case:** a permission-to-enter (indemnity) form.
- **Where they show up:** a full "Notes & documents" section on the property page, plus a small banner on the admin booking page.
- **Expiry:** none. A form stays valid until staff remove it.

**Two facts that shape the design:**
- **Nothing can go on `eligible_properties` itself.** That table is readable by anyone (`eligible_properties_public_select USING(true)`), and `/book` runs `select('*')` with the anon key. A new column would leak to the public, so notes need their own child table.
- **The MUD auth-form flow is the closest existing pattern, but its security can't be copied.** It uses a private bucket with signed upload and read URLs, but the bucket policies check role only, not tenant. A separate task chip (`task_c49224f3`) fixes that; it is not bundled here.

## Design

### 1. Table `property_note` (new migration via `pnpm supabase migration new property_notes`)

| Column | Notes |
|---|---|
| `id uuid pk default gen_random_uuid()` | |
| `property_id uuid NOT NULL → eligible_properties(id)` | Named like `allocation_override.property_id` |
| `client_id uuid NOT NULL → client(id)` | **Filled by a BEFORE INSERT trigger** from property → area → client. Caller input is never trusted. Gives RLS a cheap, indexed column, and `audit_trigger_fn` picks up `client_id` automatically (line 41), so the audit function needs no change |
| `kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('access_form','note'))` | |
| `body text CHECK (char_length(body) <= 2000)` | |
| `file_path text UNIQUE`, `file_name text`, `file_type text`, `file_size int CHECK (file_size <= 10485760)` | Columns follow the `bug_report_attachment` shape |
| `created_by uuid NOT NULL DEFAULT auth.uid()`, `created_at timestamptz DEFAULT now()` | |
| `removed_at timestamptz`, `removed_by uuid` | Soft remove only |

**CHECK constraints:**
- `body IS NOT NULL OR file_path IS NOT NULL`
- `kind <> 'access_form' OR file_path IS NOT NULL`: an access form must have its file.

**Indexes:** `(property_id) WHERE removed_at IS NULL` and `(client_id)`.

**Immutability trigger (BEFORE UPDATE):** the only change allowed is `removed_at` going from NULL to `now()`; the trigger stamps `removed_by = auth.uid()`. Any other column change raises. Pinning columns with a trigger rather than RLS follows ADR 0012. There are no edits: to fix an entry, remove it and add it again. Every change is captured by the audit trigger.

**Audit:** attach `audit_trigger_fn()` AFTER INSERT/UPDATE/DELETE.

### 2. RLS on `property_note` (enabled, default deny)

The **staff gate** is the same for every policy:
- `(SELECT current_user_role()) IN ('contractor-admin','contractor-staff','client-admin','client-staff')`
- `AND client_id IN (SELECT accessible_client_ids())`
- `AND ((SELECT current_user_sub_client_id()) IS NULL OR EXISTS (SELECT 1 FROM eligible_properties ep JOIN collection_area ca ON ca.id = ep.collection_area_id WHERE ep.id = property_note.property_id AND ca.sub_client_id = (SELECT current_user_sub_client_id())))`

The sub-client clause is a correlated primary-key lookup. Because every read targets one property, this measured faster than the ADR 0019 / #616 set shape: about 6 ms against 12.5 ms for a council-scoped read, tested on prod and rolled back. All stable helpers are wrapped in `(select …)`.

Policies:
- **SELECT:** the staff gate.
- **INSERT:** the staff gate, plus `created_by = auth.uid()`.
- **UPDATE:** the staff gate in both USING and WITH CHECK. The trigger limits what can actually change.
- **DELETE:** no policy. Nothing is deleted from the app.

**Who gets nothing:** field, ranger, resident, strata and anon all see zero rows.

### 3. Storage bucket `property-documents`

- Private bucket, 10 MB limit.
- Allowed types: `application/pdf`, `image/jpeg`, `image/png`, `image/heic`, `image/webp`.
- Path format: `{client_id}/{property_id}/{uuid}-{safeName}`.

Policies on `storage.objects`:
- **INSERT:** bucket matches, AND the INVOKER helper `can_upload_property_document(name)` returns true. The helper checks that the caller has a staff role, that folder[1] is in `accessible_client_ids()`, and that folder[2] is a property in that client which passes the sub-client predicate. On a malformed path it returns false rather than raising.
- **SELECT:** bucket matches, AND either of:
  - `EXISTS (SELECT 1 FROM public.property_note pn WHERE pn.file_path = objects.name)`. This inherits `property_note` RLS, so files and rows can't drift apart.
  - `owner_id = auth.uid()` AND `can_upload_property_document(name)`. This lets an uploader see their own not-yet-attached object. It is needed because Storage's upload permission check is an `INSERT … RETURNING`, which must also pass SELECT before the note row exists.
- **No UPDATE or DELETE policies:** stored files are immutable.

### 4. ADR `docs/adr/0031-property-notes-are-staff-only-and-never-deleted.md` + README row

In plain English:
- Notes and forms live in their own staff-only record.
- Each council sees only its own.
- "Remove" hides an entry but keeps it for the record, because the form is an indemnity.
- Crews don't see them.

### 5. Server actions in `src/app/(admin)/admin/properties/[id]/property-notes-actions.ts`

Every action:
- validates input with zod;
- calls `validateStaffRole()` (`src/lib/auth/server.ts:32`);
- resolves `getCurrentAdminClient()` (`src/lib/admin/current-client.ts:59`);
- re-reads the property with `.eq('collection_area.client_id', client.id)`, because the public-SELECT trap means RLS alone won't scope it;
- returns `Result<T>`, never throws.

Actions:
- `createPropertyDocumentUploadUrl(propertyId, fileName, fileType, fileSize)`: checks type and size, builds the path, then calls `createSignedUploadUrl` under the user session. Follows the `createAuthFormUploadUrl` pattern (`properties/actions.ts:619`), but adds the tenant check that action lacks.
- `addPropertyNote({ propertyId, kind, body?, file? })`: rejects a `file.path` that doesn't start with `${clientId}/${propertyId}/`, then inserts.
- `removePropertyNote(noteId)`: sets `removed_at = now()`, then asserts rows affected. A silent RLS no-op must surface as an error.
- `getPropertyDocumentUrl(noteId)`: reads `file_path` from the RLS-scoped row and returns a `createSignedUrl(path, 300)`. **It never accepts a raw path**, unlike `getAuthFormSignedUrl`.

Shared pure helpers go in `src/lib/property-notes/validation.ts`: `ALLOWED_TYPES`, `MAX_BYTES`, `safeFileName`, `buildDocumentPath`, and the zod schemas for the kind/body/file rules. They live there so unit tests and the client form can share them.

### 6. UI

**Property page.** New `src/app/(admin)/admin/properties/[id]/property-notes-section.tsx` (client component), rendered in `property-detail-client.tsx` after `PropertyEditSection`.
- **Each entry shows:**
  - a kind badge: "Permission to enter" or "Note", using `lib/ui/status-styles.ts` pairs;
  - the body text;
  - a file link, "View form.pdf (1.2 MB)", which opens through `getPropertyDocumentUrl` in a new tab;
  - "Added by Kim Lenton · 13/10/2026";
  - a Remove button behind a confirm dialog.
- **Add form:** type select, textarea, and a file input using the same `accept` list as the MUD form.
  - It validates before upload.
  - Upload sequence: upload URL → `uploadToSignedUrl` → `addPropertyNote`.
- **Errors:** every action `catch` uses `staleActionMessage(err) ?? msg`.
- **Styling:** token-only type scale, no arbitrary `text-[Npx]`.

**Property data loading.** In `properties/[id]/page.tsx`:
- fetch active `property_note` rows (RLS-scoped);
- resolve author names through `profiles` in JS, as the bug-report comments do;
- add `{ table: 'property_note', fkColumn: 'property_id' }` to the `resolveAuditLogs` `includeChildren` call so entries appear in History.

**Audit labels.** Add `property_note` columns to `src/lib/audit/field-labels.ts`.

**Booking page banner.**
- In `bookings/[id]/page.tsx`, run a small RLS-scoped `property_note` query (`kind`, where `removed_at IS NULL`) for `booking.property_id`.
- `booking-detail-client.tsx` shows an info banner by the address:
  - "Permission-to-enter form on file · View property →" if any access form exists;
  - otherwise "N property notes on file · View property →".
- Non-MUD bookings currently have no property link, so the banner adds one.

### 7. Delivery: two PRs, both off `origin/develop`

This worktree is on a main-based branch, so both PRs branch from `origin/develop`. They are split because the Types Freshness check generates types from prod, so the new table must be live before any code uses it.
- **PR-A `feature/property-notes-schema`:** migration (table, trigger, RLS, bucket, storage policies, audit trigger) plus the ADR. Merge to develop. **Dan cuts the release.**
- **PR-B `feature/property-notes-ui`:**
  - regenerated `types.ts` (lockfile-pinned CLI; diff it to confirm the only change is `property_note`), then `scripts/sync-mirrors.sh`;
  - actions, helpers, UI and the booking banner;
  - field labels;
  - tests.

## Out of scope (YAGNI, per Dan's answers)

- Crew, ranger or resident visibility, and pushing anything into OptimoRoute notes.
- Expiry dates.
- Editing an entry (remove and re-add instead), and hard delete.
- Moving the existing MUD `auth_form_url` into this table. The MUD Registered gate depends on it; it stays as-is.
- Hardening the MUD and client-assets buckets: that is chip `task_c49224f3`.

## Verification

1. **Unit (Vitest):** `src/__tests__/property-notes-validation.test.ts` covers the type and size limits, `safeFileName`, the path builder, and the kind/body/file rules (an access form without a file is rejected; a note needs a body or a file).
2. **RLS:** add a new `describe` block to `src/__tests__/rls.test.ts` and run it with `pnpm test:rls`. It asserts:
   - a contractor-admin sees the rows;
   - a same-client client-admin sees them;
   - a client-admin from another client sees 0;
   - sub-client-narrowed staff from another sub-client see 0;
   - field, ranger and resident see 0;
   - a ranger INSERT is rejected;
   - an UPDATE of `body` is rejected by the trigger;
   - a removal stamps `removed_by`;
   - a client from another tenant can't SELECT the storage object.
3. **Prod after the PR-A release:**
   - run a rolled-back impersonation (`begin; set_config('request.jwt.claims',…); set local role authenticated; …; rollback`) as a council-scoped user and as a contractor user;
   - run `EXPLAIN ANALYZE` on the SELECT to confirm it stays in single-digit ms.
4. **Local:**
   - run `pnpm test`, `pnpm tsc --noEmit`, `pnpm lint` and `pnpm build`;
   - start the dev server via `preview_start`, then on a property: add a note, add a permission-to-enter form with a PDF, open it through the signed link, remove it, and check the History panel;
   - open a booking for that property and confirm the banner and link;
   - screenshot the result as proof.
5. **E2E:** `tests/e2e/admin-property-notes.spec.ts`, following the existing admin spec patterns. Add a note with a file, see it listed, remove it, and see the booking banner.
