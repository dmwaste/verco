-- Identity helper: resolve the caller's contact_id by matching their auth
-- email to a contacts row (fallback for residents whose profiles.contact_id
-- link predates the direct FK — see the booking-flow email-matching pattern).
--
-- PROVENANCE BACK-FILL: this function was originally created out-of-band on
-- prod and had no CREATE in any migration, so the policy below (which calls it)
-- broke every fresh-database replay — `supabase db reset`, preview branches,
-- local dev, CI shadow DBs — at 42883 "function does not exist". Prod already
-- has it recorded at this migration version, so `db push` never re-runs this
-- file; this CREATE OR REPLACE only executes on from-scratch replays, giving
-- the reference below its dependency. Definition mirrors prod exactly.
--
-- SECURITY DEFINER + pinned search_path per CLAUDE.md §21. Deliberately NOT
-- revoked from anon: it is an identity helper referenced by public-SELECT RLS
-- policies, so anon must retain EXECUTE (revoking 42501s the /book flow); it is
-- inert for anon anyway (auth.uid() is NULL → returns nothing). Matches the
-- live prod function (same query, SECURITY DEFINER, STABLE, pinned search_path).
CREATE OR REPLACE FUNCTION public.current_user_contact_id_by_email()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id
  FROM contacts c
  JOIN profiles p ON p.email = c.email
  WHERE p.id = auth.uid()
  LIMIT 1;
$$;

-- Allow residents to read their own booking payments (for receipt URL display)
CREATE POLICY booking_payment_resident_select ON booking_payment
  FOR SELECT
  USING (
    booking_id IN (
      SELECT b.id FROM booking b
      WHERE b.contact_id = current_user_contact_id()
         OR b.contact_id = current_user_contact_id_by_email()
    )
  );

-- Allow staff to read booking payments for bookings in their scope
CREATE POLICY booking_payment_staff_select ON booking_payment
  FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (
      current_user_role() IN ('contractor-admin', 'contractor-staff', 'client-admin', 'client-staff')
    )
  );
