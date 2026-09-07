-- #426 (decision 22/08/2026): client-tier date moves respect capacity;
-- contractor keeps the #378 override.
--
-- Prod showed 6 KWN dates over bulk capacity since 01/07 — 15 of the 21
-- contributing writes were admin date moves INTO an already-full date, which
-- updateCollectionDetails deliberately never capacity-gated (D1: "a correction,
-- not a new booking"). That exemption now applies to contractor-tier only.
-- App layer: capacityBlocksMove() in updateCollectionDetails + the picker.
-- DB layer (this migration): the client-tier branch of
-- enforce_booking_item_staff_write (20260822050000) additionally rejects a
-- date move when the target bucket lacks room for the item's units.
--
-- Per-row: each moved item checks its own category against the target's
-- counters; recalculate_collection_date_units (AFTER ROW) updates the counters
-- between rows, so a multi-item booking is checked cumulatively. Pool-aware:
-- pooled areas keep counters on collection_date_pool (collection_date stays 0);
-- a missing pool row is treated as closed, same as the booking RPC.

CREATE OR REPLACE FUNCTION public.enforce_booking_item_staff_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role           app_role := current_user_role();
  v_booking_status booking_status;
  v_booking_area   uuid;
  v_date_open      boolean;
  v_date           date;
  v_date_area      uuid;
  v_today          date := (now() AT TIME ZONE 'Australia/Perth')::date;
  v_pool_id        uuid;
  v_cat            text;
  v_limit          integer;
  v_booked         integer;
BEGIN
  IF v_role IS NULL THEN
    RETURN NEW;
  END IF;

  -- (a) Identity + price columns are immutable under ANY user JWT.
  IF NEW.booking_id       IS DISTINCT FROM OLD.booking_id
     OR NEW.service_id       IS DISTINCT FROM OLD.service_id
     OR NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
     OR NEW.is_extra         IS DISTINCT FROM OLD.is_extra THEN
    RAISE EXCEPTION 'booking_item identity and price columns cannot be changed';
  END IF;

  -- (b) Date moves: target must belong to the booking's own area — every role.
  IF NEW.collection_date_id IS DISTINCT FROM OLD.collection_date_id THEN
    SELECT b.collection_area_id, b.status
      INTO v_booking_area, v_booking_status
      FROM booking b WHERE b.id = NEW.booking_id;
    SELECT cd.is_open, cd.date, cd.collection_area_id
      INTO v_date_open, v_date, v_date_area
      FROM collection_date cd WHERE cd.id = NEW.collection_date_id;

    IF v_date_area IS DISTINCT FROM v_booking_area THEN
      RAISE EXCEPTION 'Target collection date is not in this booking''s collection area';
    END IF;
  END IF;

  -- (c) Client-tier restrictions — mirrors canEditCollectionDetails,
  --     canRescheduleToTargetDate and capacityBlocksMove.
  IF (v_role IN ('client-admin'::app_role, 'client-staff'::app_role)) IS TRUE THEN
    IF v_booking_status IS NULL THEN
      SELECT b.status INTO v_booking_status FROM booking b WHERE b.id = NEW.booking_id;
    END IF;

    IF v_booking_status NOT IN (
         'Pending Payment'::booking_status,
         'Submitted'::booking_status,
         'Confirmed'::booking_status
       ) THEN
      RAISE EXCEPTION 'Only contractor staff may edit items on a % booking', v_booking_status;
    END IF;

    IF NEW.collection_date_id IS DISTINCT FROM OLD.collection_date_id THEN
      IF COALESCE(v_date_open, false) = false OR v_date < v_today THEN
        RAISE EXCEPTION 'Only contractor staff may move a booking onto a closed or past collection date';
      END IF;

      -- Capacity (#426): the item's bucket must have room for its units.
      SELECT c.code INTO v_cat
        FROM service s JOIN category c ON c.id = s.category_id
       WHERE s.id = NEW.service_id;
      SELECT ca.capacity_pool_id INTO v_pool_id
        FROM collection_area ca WHERE ca.id = v_date_area;

      IF v_pool_id IS NOT NULL THEN
        SELECT CASE v_cat WHEN 'bulk' THEN p.bulk_capacity_limit WHEN 'anc' THEN p.anc_capacity_limit WHEN 'id' THEN p.id_capacity_limit END,
               CASE v_cat WHEN 'bulk' THEN p.bulk_units_booked  WHEN 'anc' THEN p.anc_units_booked  WHEN 'id' THEN p.id_units_booked  END
          INTO v_limit, v_booked
          FROM collection_date_pool p
         WHERE p.capacity_pool_id = v_pool_id AND p.date = v_date;
        IF NOT FOUND THEN
          v_limit := 0; v_booked := 0;
        END IF;
      ELSE
        SELECT CASE v_cat WHEN 'bulk' THEN d.bulk_capacity_limit WHEN 'anc' THEN d.anc_capacity_limit WHEN 'id' THEN d.id_capacity_limit END,
               CASE v_cat WHEN 'bulk' THEN d.bulk_units_booked  WHEN 'anc' THEN d.anc_units_booked  WHEN 'id' THEN d.id_units_booked  END
          INTO v_limit, v_booked
          FROM collection_date d WHERE d.id = NEW.collection_date_id;
      END IF;

      IF v_limit IS NOT NULL AND NEW.no_services > (v_limit - COALESCE(v_booked, 0)) THEN
        RAISE EXCEPTION 'Only contractor staff may move a booking onto a full collection date';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_booking_item_staff_write() FROM PUBLIC, anon;
