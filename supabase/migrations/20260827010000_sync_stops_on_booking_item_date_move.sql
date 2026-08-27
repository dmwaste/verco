-- Cancel a dispatched stop the moment its booking is rescheduled off that date.
--
-- Problem this fixes (KWN-4-X96WUS, 26/08/2026): an admin moved a Confirmed
-- booking from 27/08 to 03/09 at 07:57 AWST. The booking_item moved, but the
-- already-pushed collection_stop for 27/08 stayed Pending — so its OptimoRoute
-- order stayed live. Nine hours later pull-optimoroute-routes pulled the 27/08
-- plan back and stamped the stop with driver KWNA, sequence 6, ETA 08:13: a
-- phantom stop, planned into a route for a resident who was no longer booked
-- that day (and who OptimoRoute then notifies). The stop was only cancelled at
-- 03:10 AWST on 27/08 — the collection morning — by push-orders-to-optimoroute's
-- pass-1 reconciliation, and the OR order deleted at 03:20 by
-- sync-optimoroute-cancellations. Eleven live bookings have hit this since July.
--
-- The predicate was never wrong — only its cadence. `shouldCancelOrphanStop`
-- (_shared/stops.ts) already cancels a Pending stop when the booking has no
-- current item on that stop's (date, stream); it just runs once a day, at
-- 03:10 AWST. This trigger applies the identical rule at write time, so the
-- hourly cancellation sweep (xx:20 UTC) removes the OptimoRoute order within
-- the hour instead of up to a day later. That matters because crews get their
-- routes at 8pm the night before: a 03:10 cancellation landed after dispatch,
-- so the crew went out with the phantom stop still on the route. The sibling
-- migration 20260827020000 closes the same hole in the other direction. It mirrors sync_stops_on_booking_status,
-- which already does exactly this for booking CANCELLATION — a date move simply
-- had no equivalent.
--
-- Not a departure from ADR 0009 (stop = dispatched record, booking = corrected
-- intent): the stop is CANCELLED, never repointed at the new date. Terminal
-- stops (Completed / NCN / NP) are untouched, so a wrong-day miss can still
-- never be laundered into an on-time success, and the push EF revives the row
-- onto the new date when that date locks at T-3 (the UNIQUE(booking_id, stream)
-- revival carve-out in enforce_stop_state_transition).
--
-- SECURITY DEFINER: collection_stop has no staff UPDATE policy (only the field
-- closeout one), so an admin's booking_item write could not otherwise cancel
-- the stop.
--
-- Sibling migration 20260827030000 guards the rollup this trigger can fire:
-- cancelling the last Pending stop of a Scheduled mixed booking whose other
-- stream is already terminal must not flip the booking to Completed.
--
-- Two residuals accepted in review (both heal at the next hourly push run,
-- so exposure is <=1h either way):
--   1. Undo is not instant: A->B then B->A leaves the stop Cancelled — this
--      trigger cannot revive (enforce_stop_state_transition reserves
--      Cancelled->Pending for privileged callers, and relaxing that would let
--      any staff writer un-cancel dispatched history). Pass-1 revives it.
--   2. update_booking_items_in_place's date changes DO fire this trigger (its
--      kept-item UPDATE sets collection_date_id), but a DROPPED service line
--      is a DELETE and doesn't; the vacated stream's stop waits for pass-1.
--      Deliberate: an AFTER DELETE trigger sees the RPC's transient mid-edit
--      state (delete-then-reinsert on re-price) and would cancel stops that
--      are about to come back.

CREATE OR REPLACE FUNCTION sync_stops_on_booking_item_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Per (date, stream), not per booking: a booking whose ancillary items move
  -- while its bulk items stay must cancel only the ancillary stop. AFTER ROW
  -- triggers fire at end of statement, so a multi-item move sees every row
  -- already updated and this reads the booking's final item set.
  UPDATE collection_stop cs
  SET status = 'Cancelled'::stop_status,
      cancelled_at = now()
  WHERE cs.booking_id = NEW.booking_id
    AND cs.status = 'Pending'::stop_status
    AND NOT EXISTS (
      SELECT 1
      FROM booking_item bi
      JOIN service s ON s.id = bi.service_id
      WHERE bi.booking_id = cs.booking_id
        AND bi.collection_date_id = cs.collection_date_id
        AND s.waste_stream = cs.stream
    );

  RETURN NULL;
END;
$$;

-- Deliberately NOT filtered on pushed_at. sync-optimoroute-cancellations sweeps
-- cancelled stops regardless of pushed_at for the same reason: if the push EF
-- died between the routing-API call and the pushed_at stamp, the order exists
-- in OptimoRoute with no stamp, and filtering here would orphan it there.
-- Sweeping a never-pushed stop is a harmless not-found no-op.
DROP TRIGGER IF EXISTS sync_stops_on_booking_item_date ON booking_item;
CREATE TRIGGER sync_stops_on_booking_item_date
  AFTER UPDATE OF collection_date_id ON booking_item
  FOR EACH ROW
  WHEN (NEW.collection_date_id IS DISTINCT FROM OLD.collection_date_id)
  EXECUTE FUNCTION sync_stops_on_booking_item_date();
