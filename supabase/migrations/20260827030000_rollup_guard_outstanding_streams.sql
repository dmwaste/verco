-- rollup_booking_status_from_stops: don't roll a booking up to a terminal
-- status while one of its booked streams has no live (non-Cancelled) stop.
--
-- Failure this closes (found in review of the 20260827010000 date-move
-- trigger, but the path pre-exists via push-orders-to-optimoroute's pass-1
-- cancel): a Scheduled mixed booking on collection day — general stop already
-- Completed, ancillary stop still Pending — has its date moved by contractor
-- staff (a #378 correction; canEditCollectionDetails allows it). The move
-- cancels the ancillary Pending stop, the rollup then sees pending=0 and one
-- live terminal stop, and flips the booking Scheduled → Completed. The push
-- EF's desired-stop fetch is Confirmed/Scheduled only, so the moved ancillary
-- collection is never dispatched: a silent missed collection behind a booking
-- the resident sees as "Completed".
--
-- Guard: an item whose stream has NO non-Cancelled stop is an outstanding
-- collection — the booking is not finished, whatever the closed stops say.
-- Keyed on STREAM, not (date, stream): UNIQUE(booking_id, stream) means a
-- stream has exactly one stop row ever, and a #378 correction deliberately
-- leaves a terminal stop on the dispatched date while the item points at the
-- corrected date (ADR 0009) — a date-keyed guard would strand those forever.
-- The cancelled stop revives onto the new date when it locks (push EF pass-1),
-- the crew closes it there, and the rollup then completes normally.
--
-- Normal closeouts are unaffected: every booked stream got its stop at the
-- T-3 push, so by the time the last stop goes terminal every stream is
-- covered. Dropped streams (quantity edit removes a line) don't block either:
-- the item is gone, so it isn't checked.
--
-- The reads (booking_item, service, collection_stop) run under the invoking
-- user's RLS like the existing stop count: a field user closing out can see
-- the booking's items (run-sheet transitive SELECT), service is public-SELECT.
--
-- Mirror note: computeRollup in _shared/stops.ts derives status from stop
-- statuses alone and cannot see this guard — the DB trigger stays
-- authoritative (its comment says so).
CREATE OR REPLACE FUNCTION public.rollup_booking_status_from_stops()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pending  integer;
  v_ncn      integer;
  v_np       integer;
  v_live     integer;  -- non-Cancelled terminal stops
  v_rollup   booking_status;
BEGIN
  -- Serialise rollups per booking. Without this, two crews closing the last
  -- two sibling stops concurrently each see the other as Pending in their
  -- READ COMMITTED snapshot, BOTH skip the rollup, and the booking strands
  -- in Scheduled forever (terminal stops are immutable, so nothing re-fires).
  -- After blocking here, the count statement below gets a fresh snapshot and
  -- sees the other transaction's committed terminal status. Same key scheme
  -- as the capacity RPCs.
  PERFORM pg_advisory_xact_lock(('x' || substr(NEW.booking_id::text, 1, 8))::bit(32)::bigint);

  SELECT
    count(*) FILTER (WHERE status = 'Pending'),
    count(*) FILTER (WHERE status = 'Non-conformance'),
    count(*) FILTER (WHERE status = 'Nothing Presented'),
    count(*) FILTER (WHERE status <> 'Cancelled')
  INTO v_pending, v_ncn, v_np, v_live
  FROM collection_stop
  WHERE booking_id = NEW.booking_id;

  IF v_pending > 0 OR v_live = 0 THEN
    RETURN NULL;  -- stops still open, or everything cancelled — nothing to roll up
  END IF;

  -- Outstanding-stream guard (see header): a booked stream with no live stop
  -- is a collection still owed — a date move cancelled its stop and the new
  -- date hasn't locked yet. Stay Scheduled so the push EF (Confirmed/Scheduled
  -- fetch) revives the stream's stop when the moved-to date locks.
  IF EXISTS (
    SELECT 1
    FROM booking_item bi
    JOIN service s ON s.id = bi.service_id
    WHERE bi.booking_id = NEW.booking_id
      AND NOT EXISTS (
        SELECT 1 FROM collection_stop cs
        WHERE cs.booking_id = NEW.booking_id
          AND cs.stream = s.waste_stream
          AND cs.status <> 'Cancelled'
      )
  ) THEN
    RETURN NULL;
  END IF;

  v_rollup := CASE
    WHEN v_ncn > 0 THEN 'Non-conformance'::booking_status
    WHEN v_np  > 0 THEN 'Nothing Presented'::booking_status
    ELSE 'Completed'::booking_status
  END;

  UPDATE booking
  SET status = v_rollup
  WHERE id = NEW.booking_id
    AND status = 'Scheduled';

  RETURN NULL;
END;
$$;
