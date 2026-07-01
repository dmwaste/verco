-- ============================================================================
-- VER-179 SLA dashboard §3.4 / §4.1 — SR first-response sub-SLA (FRSTAMP)
-- ============================================================================
-- service_ticket.first_response_at is never populated today, so the SR card's
-- first-response sub-metric ("respond ≤ 3 working days") has no basis. Stamp it
-- with the created_at of the FIRST non-internal STAFF reply on the ticket
-- (author_type='staff' — the only staff value in ticket_response, verified prod).
-- Idempotent: fills only while still NULL, so it captures the FIRST response and
-- never moves on later replies. Resident replies never stamp.
--
-- SECURITY DEFINER: the trigger UPDATEs service_ticket regardless of the inserting
-- user's RLS (a resident replying inserts a ticket_response row but the author_type
-- guard prevents any stamp; a staff reply stamps as owner).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.stamp_first_response()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.author_type = 'staff' AND NEW.is_internal = false THEN
    UPDATE service_ticket
       SET first_response_at = NEW.created_at
     WHERE id = NEW.ticket_id
       AND first_response_at IS NULL;  -- idempotent: first response only
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ticket_response_stamp_first_response ON public.ticket_response;
CREATE TRIGGER ticket_response_stamp_first_response
  AFTER INSERT ON public.ticket_response
  FOR EACH ROW EXECUTE FUNCTION public.stamp_first_response();

-- Backfill historical tickets: earliest non-internal staff reply per ticket.
UPDATE service_ticket st
   SET first_response_at = fr.first_at
  FROM (
    SELECT ticket_id, min(created_at) AS first_at
      FROM ticket_response
     WHERE author_type = 'staff' AND is_internal = false
     GROUP BY ticket_id
  ) fr
 WHERE st.id = fr.ticket_id
   AND st.first_response_at IS NULL;
