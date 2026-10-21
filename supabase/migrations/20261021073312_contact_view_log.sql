-- Contact view log (VER-322, PRIS gap 7, ADR 0040).
--
-- Records which staff member opened which resident contact, when, and on which
-- screen. Every answered call now opens the caller lookup (VER-316), which shows
-- the resident's name, phone, email, bookings and tickets, and nothing recorded
-- those reads until now.
--
-- Shape:
--   1. contact_view_log: one row per contact shown. Append-only.
--   2. RLS:
--        INSERT: any staff role, only as themselves and only "now", so nobody
--                can log a view in someone else's name or backdate one. There
--                is deliberately no "can you see this contact" check: it re-runs
--                contacts RLS, measured on prod at ~620 ms per insert against
--                ~0.4 ms without, on the path of every answered call. All it
--                would stop is a staff member logging, against their own name,
--                a view of a contact id they can't open, which reveals nothing.
--        SELECT: contractor-admin and client-admin, for contacts they can see.
--                Council scoping comes from contacts RLS itself (booking-,
--                ticket- and strata-based, already narrowed to a sub-client):
--                a Cottesloe-only admin sees views of Cottesloe residents and
--                nobody else's. The rule is the resident's council, not the
--                viewer's, so a council sees D&M's views of its residents too.
--        No UPDATE or DELETE policy or grant: staff can't edit or remove a row.
--   3. Grants: authenticated SELECT + INSERT only, anon nothing. Written out
--      in full because Supabase stops default grants on new public tables
--      from 30/10/2026, and until then its defaults hand anon and
--      authenticated everything, TRUNCATE included.
--
-- Not audited (no audit_trigger_fn): each row is itself the audit record and
-- API roles can't change it, so an audit trigger would only copy every view
-- into audit_log.
--
-- Idempotent: IF NOT EXISTS, DROP … IF EXISTS.

-- ── 1. Table ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contact_view_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES public.contacts(id),
  viewed_by   uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  -- Where the contact was opened. The 360 timeline (VER-318) adds its own value.
  surface     text NOT NULL CHECK (surface IN ('caller_lookup'))
);

COMMENT ON TABLE public.contact_view_log IS
  'Who opened which resident contact, when and where (VER-322, PRIS gap 7). '
  'Append-only: staff insert their own views; admins read views of contacts '
  'they can see. ADR 0040.';

-- "Who has looked at this resident?" and "what has this staff member opened?"
CREATE INDEX IF NOT EXISTS idx_contact_view_log_contact
  ON public.contact_view_log (contact_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_view_log_viewer
  ON public.contact_view_log (viewed_by, viewed_at DESC);

-- ── 2. RLS ───────────────────────────────────────────────────────────────

ALTER TABLE public.contact_view_log ENABLE ROW LEVEL SECURITY;

-- viewed_at = now() holds for the column default: now() is fixed for the
-- transaction, so only a caller-supplied timestamp fails it.
DROP POLICY IF EXISTS contact_view_log_staff_insert ON public.contact_view_log;
CREATE POLICY contact_view_log_staff_insert ON public.contact_view_log
  FOR INSERT TO authenticated
  WITH CHECK (
    viewed_by = (SELECT auth.uid())
    AND viewed_at = now()
    AND (SELECT current_user_role()) IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    )
  );

-- Uncorrelated set: contacts RLS runs once per statement however many log
-- rows are read (the #616 shape). ~0.6 s on prod, fine for an admin-only read.
DROP POLICY IF EXISTS contact_view_log_admin_select ON public.contact_view_log;
CREATE POLICY contact_view_log_admin_select ON public.contact_view_log
  FOR SELECT TO authenticated
  USING (
    (SELECT current_user_role()) IN ('contractor-admin', 'client-admin')
    AND contact_id IN (SELECT c.id FROM contacts c)
  );

-- ── 3. Grants ────────────────────────────────────────────────────────────

REVOKE ALL ON public.contact_view_log FROM anon, authenticated;
GRANT SELECT, INSERT ON public.contact_view_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_view_log TO service_role;
