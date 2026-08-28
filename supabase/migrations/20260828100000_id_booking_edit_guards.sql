-- ID booking edit guards (design: docs/superpowers/specs/2026-08-28-id-booking-edit-design.md)
--
-- 1. audit_trigger_fn: stop stripping `photos` from stored diffs. The strip
--    made photo appends invisible — a photos-only save wrote an audit row
--    whose visible diff was empty, so "who added this evidence photo, when"
--    (the exact enforcement question) was unanswerable. The column holds
--    text URLs (bounded small arrays), not blobs, so row size is a non-issue;
--    NCN/NP photo evidence gains the same trail for free. `geom` stays
--    stripped (PostGIS payloads are genuinely large + unreadable).
--
-- 2. enforce_booking_id_fields_write: defence-in-depth trigger for the
--    ID-specific columns (geo_address, latitude, longitude, id_waste_types,
--    id_volume, photos) on Illegal Dumping bookings. booking_staff_update
--    RLS has no column or status restriction, so without this the
--    "contractor-only" rule would live solely in a server action — one
--    refactor from evaporating, on the record councils use as illegal-
--    dumping evidence. Mirrors canEditIdDetails() in
--    src/lib/booking/collection-details-edit.ts.

-- ── 1. audit_trigger_fn keeps `photos` ────────────────────────────────
-- Full re-emit of the live prod definition (20260515053849 + the 20260702
-- search_path pin) with ONE change: the strip line drops only 'geom'.
-- CREATE OR REPLACE resets a fn's search_path pin, so the pin is declared
-- inline (CLAUDE.md §21 DB objects).

CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old jsonb := NULL; v_new jsonb := NULL; v_record_id uuid; v_client_id uuid := NULL; v_contractor_id uuid := NULL; v_actor uuid;
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
  v_actor := COALESCE(auth.uid(), NULLIF(current_setting('app.audit_actor', true), '')::uuid);
  INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, changed_by, client_id, contractor_id) VALUES (TG_TABLE_NAME, v_record_id, TG_OP, v_old, v_new, v_actor, v_client_id, v_contractor_id);
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ── 2. ID-fields write guard ──────────────────────────────────────────
--
-- Check ordering is load-bearing:
--   a. Cheapest first — bail unless this is an ID booking AND one of the six
--      guarded columns is actually changing. Every field-crew closeout and
--      every staff cancellation is a booking UPDATE; running the role gate
--      first would break those at 6am.
--   b. Privileged pass-through uses the collection_stop trigger's EXACT
--      pattern (20260610010100): claims NULL (direct SQL / pg_cron repair
--      sessions) or service_role both pass. NOT a NULL-current_user_role()
--      shorthand — the manual-repair escape hatch must keep working.
--   c. Role gate NULL-safe: current_user_role() is NULL for role-less
--      authenticated callers and NULL <> 'x' is falsy (CLAUDE.md §21).
--   d. Status predicate mirrors canEditIdDetails: the 5 editable statuses.
--      Without it a contractor JWT could restate evidence on Cancelled/NCN
--      records via raw PostgREST — the contested-record class.
--   e. Photos append-only: array containment (@>) is set semantics — the
--      same deduped-set-superset definition the server action applies.
-- Uses OLD.type/OLD.status (caller-suppliable NEW values prove nothing).

CREATE OR REPLACE FUNCTION public.enforce_booking_id_fields_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims jsonb;
BEGIN
  IF OLD.type <> 'Illegal Dumping' THEN
    RETURN NEW;
  END IF;
  IF NEW.geo_address    IS NOT DISTINCT FROM OLD.geo_address
     AND NEW.latitude       IS NOT DISTINCT FROM OLD.latitude
     AND NEW.longitude      IS NOT DISTINCT FROM OLD.longitude
     AND NEW.id_waste_types IS NOT DISTINCT FROM OLD.id_waste_types
     AND NEW.id_volume      IS NOT DISTINCT FROM OLD.id_volume
     AND NEW.photos         IS NOT DISTINCT FROM OLD.photos THEN
    RETURN NEW;
  END IF;

  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  IF v_claims IS NULL OR v_claims->>'role' = 'service_role' THEN
    RETURN NEW; -- imports, EFs, cron, direct-SQL repair sessions
  END IF;

  IF (current_user_role() IN ('contractor-admin', 'contractor-staff')) IS NOT TRUE THEN
    RAISE EXCEPTION 'Illegal dumping details can only be changed by D&M staff';
  END IF;

  IF (OLD.status IN ('Pending Payment', 'Submitted', 'Confirmed', 'Scheduled', 'Completed')) IS NOT TRUE THEN
    RAISE EXCEPTION 'Illegal dumping details cannot be changed on a "%" booking', OLD.status;
  END IF;

  IF NOT (NEW.photos @> OLD.photos) THEN
    RAISE EXCEPTION 'Evidence photos cannot be removed';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_booking_id_fields_write ON public.booking;
CREATE TRIGGER enforce_booking_id_fields_write
  BEFORE UPDATE ON public.booking
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_id_fields_write();
