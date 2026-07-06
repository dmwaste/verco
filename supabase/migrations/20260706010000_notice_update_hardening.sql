-- Notice-update hardening — defence-in-depth for the permissive staff UPDATE policy.
--
-- ncn_staff_update / np_staff_update gate on role + tenant but NOT on the values
-- being written, so a crafted SDK call from a staff token could reopen a terminal
-- notice, or repoint booking_id / client_id / reason. The state machine (and the
-- open-on-behalf action) rely on those staying put, so enforce them at the DB.
--
-- BEFORE UPDATE, shared function for both notice tables. `reason` exists only on
-- non_conformance_notice — read it generically via to_jsonb so the same function
-- serves nothing_presented (where it is always NULL → the check is a no-op).

CREATE OR REPLACE FUNCTION enforce_notice_update_rules()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Immutable identity / classification columns.
  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id THEN
    RAISE EXCEPTION 'booking_id is immutable on % records', TG_TABLE_NAME;
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'client_id is immutable on % records', TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) ->> 'reason') IS DISTINCT FROM (to_jsonb(OLD) ->> 'reason') THEN
    RAISE EXCEPTION 'reason is immutable on % records', TG_TABLE_NAME;
  END IF;

  -- A terminal investigation cannot be reopened or moved to another state.
  -- (Issued → Closed by the auto-close cron is allowed: Issued is not terminal.)
  IF OLD.status::text IN ('Resolved', 'Rescheduled', 'Rebooked', 'Closed')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'cannot change the status of a terminal % record (% -> %)',
      TG_TABLE_NAME, OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_ncn_update_rules ON non_conformance_notice;
CREATE TRIGGER enforce_ncn_update_rules
  BEFORE UPDATE ON non_conformance_notice
  FOR EACH ROW EXECUTE FUNCTION enforce_notice_update_rules();

DROP TRIGGER IF EXISTS enforce_np_update_rules ON nothing_presented;
CREATE TRIGGER enforce_np_update_rules
  BEFORE UPDATE ON nothing_presented
  FOR EACH ROW EXECUTE FUNCTION enforce_notice_update_rules();
