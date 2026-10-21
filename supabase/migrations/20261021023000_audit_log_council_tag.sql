-- ============================================================================
-- Council tag on audit_log: council-scoped staff get their History back (#614)
-- ============================================================================
-- Hotfix 20260930030000 (ADR 0024) hid the whole audit log from council-scoped
-- staff (user_roles.sub_client_id set), because it held other councils'
-- contact history. This tags each entry with the council it belongs to, so a
-- council officer sees their own council's history again and nothing else.
-- WMRC-wide, Kwinana and D&M staff are unchanged (their sub-client is NULL).
--
--   1. audit_log.sub_client_id (nullable, FK → sub_client) + an index on
--      (client_id, created_at DESC) INCLUDE (sub_client_id), replacing
--      idx_audit_log_client. Why that shape, measured on prod 21/10 (rolled
--      back) under staff JWTs:
--        * The policy's `(SELECT …) IS NULL OR sub_client_id = (SELECT …)`
--          can't drive an index seek on sub_client_id (an OR on an InitPlan
--          isn't an index condition), so a sub_client_id-leading index would
--          go unused by every read.
--        * The Audit Log page's total count is fast today only because it's
--          an index-only scan on idx_audit_log_client (175 ms for Verge
--          Valet's 420k entries). Once the policy reads sub_client_id, that
--          scan needs the column in the index, or it becomes 420k heap reads
--          (~5.6 s, against the ~8 s staff statement timeout), for every
--          staff user including D&M.
--        * The page's newest-50 read already took 5.8 s for a WMRC-wide user
--          (it sorted all 420k entries); an index ordered by created_at
--          within the client returns it in milliseconds, and a council
--          officer's read walks it newest-first, keeping their council's rows.
--   2. audit_log_sub_client_id(table, row): the ONE table → council map.
--      audit_trigger_fn() calls it for every new entry, and the backfill
--      (scripts/backfill-audit-log-sub-client.sh, run once after this deploys)
--      calls it for the existing ones, so old and new entries follow one rule.
--   3. audit_trigger_fn() fills the tag.
--   4. audit_log_select: council-scoped staff see entries tagged with their own
--      council. Same once-per-statement shape as before: every helper is
--      (SELECT …)-wrapped into an InitPlan; the per-row work is a plain column
--      compare. No per-row helper call on this table (CLAUDE.md §21).
--   5. resolve_actor_names (the History panel's "changed by" lookup) mirrors
--      the same council scope.
--
-- Mapping: every table with an audit trigger on prod (21/10/2026).
--   own column     collection_area (its sub_client_id)
--   area link      booking, collection_date, eligible_properties,
--                  allocation_rules, service_rules, booking_survey (older
--                  survey entries fall back to their booking)
--   booking link   booking_item, collection_stop, non_conformance_notice,
--                  nothing_presented, refund_request, service_ticket
--   property link  allocation_override, property_note, strata_user_properties
--   ticket link    ticket_response (→ service_ticket → booking)
-- Left NULL, so hidden from council-scoped staff (everyone else unchanged):
--   contacts       A contact isn't one council's. 46 Verge Valet contacts
--                  have bookings in several councils, and contacts repaired
--                  after the shared-email overwrites (ADR 0027) keep other
--                  councils' residents' old details in their history. Those
--                  before/after copies are what leaked (ADR 0024).
--   service_ticket / ticket_response with no booking: general enquiries have
--                  no council, the same rule as service_ticket RLS (ADR 0024).
--   stop_outcome_correction: the office's closeout corrections carry D&M's
--                  internal reason; the table itself is contractor-only
--                  (20261013160000), so its history stays off council screens.
--   bug_report, bug_report_attachment, bug_report_comment: support records
--                  about Verco itself, not one council's operations.
--   client         The whole client.
--   user_roles     Old entries from a trigger since removed: staff accounts,
--                  not council history.
--   Kwinana        No sub-clients, so every Kwinana entry stays NULL; its
--                  staff are whole-client and never read the tag.
--   Children of a since-deleted booking (~190 entries) can't be traced and
--   stay NULL. Any audited table added later stays NULL until it is mapped
--   in audit_log_sub_client_id(): fail closed for council staff.
--
-- Deploy locks: ADD COLUMN with no default is catalogue-only, and Postgres
-- skips the FK's validation scan for a newly added column (6.5 ms on prod,
-- rolled back; the rest of this file minus the index held the lock 0.4 s).
-- The CREATE INDEX does scan the heap (~3 s on prod, 21/10) while the
-- ALTER's ACCESS EXCLUSIVE is held, so audited writes wait ~3-4 s once. db
-- push runs a file in one transaction, so CONCURRENTLY isn't available.
-- Release in a quiet window.
-- `lock_timeout` turns contention into a fast, re-runnable failure instead of
-- a queue of stalled writers behind the ALTER (as 20260709030000).
--
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. Column + index ───────────────────────────────────────────────────

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS sub_client_id uuid REFERENCES public.sub_client(id);

CREATE INDEX IF NOT EXISTS idx_audit_log_client_created
  ON public.audit_log (client_id, created_at DESC) INCLUDE (sub_client_id);

-- The new index leads with client_id, so it serves every use of the old one
-- (the client_id FK included). Keeping both lets the planner pick the old
-- one + a sort for the page read: it misjudges how many rows the RLS filter
-- keeps (estimates 42 of 420k), and sorting "42" rows looks cheap. That is
-- today's 5.8 s plan. With it gone, the ordered walk is the only cheaper plan
-- (checked on prod with the old index hidden: every role's page read and
-- count use the new index).
DROP INDEX IF EXISTS public.idx_audit_log_client;

-- ── 2. Table → council map ──────────────────────────────────────────────
-- p_row is the audited row as jsonb (NEW, or OLD for a DELETE). Links that
-- the row carries itself are read from it; the rest are looked up. INVOKER:
-- it runs as the table owner when audit_trigger_fn (DEFINER) or the backfill
-- calls it, and nobody else may call it.

CREATE OR REPLACE FUNCTION public.audit_log_sub_client_id(p_table text, p_row jsonb)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_area_id uuid;
BEGIN
  IF p_table = 'collection_area' THEN
    RETURN (p_row->>'sub_client_id')::uuid;
  ELSIF p_table IN ('booking', 'collection_date', 'eligible_properties', 'allocation_rules', 'service_rules') THEN
    v_area_id := (p_row->>'collection_area_id')::uuid;
  ELSIF p_table = 'booking_survey' THEN
    -- Entries written before booking_survey had collection_area_id (ADR 0016)
    -- carry only booking_id; imported Airtable surveys carry only the area.
    v_area_id := COALESCE(
      (p_row->>'collection_area_id')::uuid,
      (SELECT collection_area_id FROM booking WHERE id = (p_row->>'booking_id')::uuid)
    );
  ELSIF p_table IN ('booking_item', 'collection_stop', 'non_conformance_notice', 'nothing_presented', 'refund_request', 'service_ticket') THEN
    SELECT collection_area_id INTO v_area_id FROM booking WHERE id = (p_row->>'booking_id')::uuid;
  ELSIF p_table IN ('allocation_override', 'property_note', 'strata_user_properties') THEN
    SELECT collection_area_id INTO v_area_id FROM eligible_properties WHERE id = (p_row->>'property_id')::uuid;
  ELSIF p_table = 'ticket_response' THEN
    SELECT b.collection_area_id INTO v_area_id
      FROM service_ticket t JOIN booking b ON b.id = t.booking_id
     WHERE t.id = (p_row->>'ticket_id')::uuid;
  END IF;
  -- contacts, client, stop_outcome_correction, bug_report* and unmapped
  -- tables fall through as NULL.
  RETURN (SELECT sub_client_id FROM collection_area WHERE id = v_area_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.audit_log_sub_client_id(text, jsonb)
  FROM PUBLIC, anon, authenticated;

-- ── 3. audit_trigger_fn fills the tag ───────────────────────────────────
-- Full re-emit of the live prod definition (20260828100000, checksum matched
-- 21/10) with two additions: v_sub_client_id, and sub_client_id in the
-- INSERT. CREATE OR REPLACE resets a fn's search_path pin, so it's declared
-- inline (CLAUDE.md §21 DB objects).

CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old jsonb := NULL; v_new jsonb := NULL; v_record_id uuid; v_client_id uuid := NULL; v_contractor_id uuid := NULL; v_sub_client_id uuid := NULL; v_actor uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new := to_jsonb(NEW); END IF;
  v_record_id := COALESCE(CASE WHEN v_new IS NOT NULL THEN (v_new->>'id')::uuid END, CASE WHEN v_old IS NOT NULL THEN (v_old->>'id')::uuid END);
  -- photos deliberately KEPT (evidence trail); geom still stripped.
  IF v_old IS NOT NULL THEN v_old := v_old - 'geom'; END IF;
  IF v_new IS NOT NULL THEN v_new := v_new - 'geom'; END IF;
  IF v_new IS NOT NULL AND v_new ? 'client_id' AND v_new->>'client_id' IS NOT NULL THEN v_client_id := (v_new->>'client_id')::uuid;
  ELSIF v_old IS NOT NULL AND v_old ? 'client_id' AND v_old->>'client_id' IS NOT NULL THEN v_client_id := (v_old->>'client_id')::uuid;
  ELSIF TG_TABLE_NAME = 'booking_item' THEN SELECT client_id INTO v_client_id FROM booking WHERE id = COALESCE(CASE WHEN v_new IS NOT NULL THEN (v_new->>'booking_id')::uuid END, CASE WHEN v_old IS NOT NULL THEN (v_old->>'booking_id')::uuid END);
  ELSIF TG_TABLE_NAME = 'ticket_response' THEN SELECT client_id INTO v_client_id FROM service_ticket WHERE id = COALESCE(CASE WHEN v_new IS NOT NULL THEN (v_new->>'ticket_id')::uuid END, CASE WHEN v_old IS NOT NULL THEN (v_old->>'ticket_id')::uuid END);
  ELSIF TG_TABLE_NAME IN ('collection_date', 'eligible_properties') THEN SELECT client_id INTO v_client_id FROM collection_area WHERE id = COALESCE(CASE WHEN v_new IS NOT NULL THEN (v_new->>'collection_area_id')::uuid END, CASE WHEN v_old IS NOT NULL THEN (v_old->>'collection_area_id')::uuid END);
  ELSIF TG_TABLE_NAME IN ('allocation_rules', 'service_rules') THEN SELECT client_id INTO v_client_id FROM collection_area WHERE id = COALESCE(CASE WHEN v_new IS NOT NULL THEN (v_new->>'collection_area_id')::uuid END, CASE WHEN v_old IS NOT NULL THEN (v_old->>'collection_area_id')::uuid END);
  ELSIF TG_TABLE_NAME = 'strata_user_properties' THEN SELECT ca.client_id INTO v_client_id FROM eligible_properties ep JOIN collection_area ca ON ca.id = ep.collection_area_id WHERE ep.id = COALESCE(CASE WHEN v_new IS NOT NULL THEN (v_new->>'property_id')::uuid END, CASE WHEN v_old IS NOT NULL THEN (v_old->>'property_id')::uuid END);
  ELSIF TG_TABLE_NAME = 'allocation_override' THEN SELECT ca.client_id INTO v_client_id FROM eligible_properties ep JOIN collection_area ca ON ca.id = ep.collection_area_id WHERE ep.id = COALESCE(CASE WHEN v_new IS NOT NULL THEN (v_new->>'property_id')::uuid END, CASE WHEN v_old IS NOT NULL THEN (v_old->>'property_id')::uuid END);
  ELSIF TG_TABLE_NAME = 'contacts' THEN SELECT b.client_id INTO v_client_id FROM booking b WHERE b.contact_id = v_record_id ORDER BY b.created_at DESC LIMIT 1;
  END IF;
  IF v_new IS NOT NULL AND v_new ? 'contractor_id' AND v_new->>'contractor_id' IS NOT NULL THEN v_contractor_id := (v_new->>'contractor_id')::uuid;
  ELSIF v_old IS NOT NULL AND v_old ? 'contractor_id' AND v_old->>'contractor_id' IS NOT NULL THEN v_contractor_id := (v_old->>'contractor_id')::uuid;
  END IF;
  -- Council tag for audit_log_select (#614): one map, shared with the backfill.
  v_sub_client_id := audit_log_sub_client_id(TG_TABLE_NAME, COALESCE(v_new, v_old));
  v_actor := COALESCE(auth.uid(), NULLIF(current_setting('app.audit_actor', true), '')::uuid);
  INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, changed_by, client_id, contractor_id, sub_client_id) VALUES (TG_TABLE_NAME, v_record_id, TG_OP, v_old, v_new, v_actor, v_client_id, v_contractor_id, v_sub_client_id);
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ── 4. audit_log_select: own council's entries for council-scoped staff ──
-- Was `AND (SELECT current_user_sub_client_id()) IS NULL` (20260930030000).
-- An untagged entry (NULL) never equals a council, so it stays hidden from
-- council staff, including any entry the backfill hasn't reached yet.

DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
FOR SELECT USING (
  client_id IN (SELECT accessible_client_ids())
  AND ((SELECT current_user_role()) = ANY (ARRAY['client-admin'::app_role, 'client-staff'::app_role, 'contractor-admin'::app_role, 'contractor-staff'::app_role]))
  AND (
    (SELECT current_user_sub_client_id()) IS NULL
    OR sub_client_id = (SELECT current_user_sub_client_id())
  )
);

-- ── 5. resolve_actor_names follows the same council scope ───────────────
-- The History panel resolves "who made this change" through this DEFINER
-- RPC, whose tenant guard mirrors audit_log_select. Without the council
-- clause a council officer could resolve the name of anyone who acted only
-- in another council (resident names included). Full re-emit of the live
-- prod definition (20260702100000, checksum matched 21/10) with that one
-- clause added; CREATE OR REPLACE keeps its grants, the pin is re-declared.

CREATE OR REPLACE FUNCTION public.resolve_actor_names(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT p.id, COALESCE(p.display_name, c.full_name)
  FROM profiles p
  LEFT JOIN contacts c ON c.id = p.contact_id
  WHERE p.id = ANY(p_user_ids)
    AND COALESCE(p.display_name, c.full_name) IS NOT NULL
    -- Staff-only gate. NULL-safe: current_user_role() is NULL for a caller with
    -- no active role, and NULL IN (...) is NULL → row excluded (fails closed).
    AND (current_user_role() IN (
      'contractor-admin', 'contractor-staff', 'client-admin', 'client-staff'
    ))
    -- Tenant guard: only resolve actors who acted on an audit row within the
    -- caller's accessible clients. Mirrors audit_log's RLS SELECT scope, so it
    -- never rejects a legitimate timeline resolution (the resolver only passes
    -- changed_by ids read from audit rows the caller could already see) while
    -- blocking arbitrary cross-tenant name probing. Bounded by p_user_ids for
    -- an index-friendly semi-join; SECURITY DEFINER means this explicit
    -- client_id filter IS the scope (it bypasses audit_log RLS).
    AND p.id IN (
      SELECT al.changed_by
      FROM audit_log al
      WHERE al.changed_by = ANY(p_user_ids)
        AND al.client_id IN (SELECT accessible_client_ids())
        AND (
          (SELECT current_user_sub_client_id()) IS NULL
          OR al.sub_client_id = (SELECT current_user_sub_client_id())
        )
    );
$fn$;
