-- Recalc trigger handles booking_item.collection_date_id changes.
--
-- The previous version used COALESCE(NEW.collection_date_id, OLD.collection_date_id)
-- which on an UPDATE that changes the date picked NEW only, leaving the OLD
-- date's counters inflated. INSERT-only and DELETE-only callers were fine —
-- but VER-208's smart-diff RPC issues UPDATEs that move an item to a new
-- date, and those need both dates recalculated.
--
-- This refactor:
--   1. Identifies the affected date_ids (1 for INSERT/DELETE/same-date UPDATE,
--      2 for a date-change UPDATE).
--   2. Loops over them, applying the existing recalc body unchanged per date.
--
-- The two halves of the body (unpooled per-area path vs pool path) are
-- preserved verbatim from migration 20260513080000_capacity_pool.sql —
-- only the entry/exit is reshaped.

CREATE OR REPLACE FUNCTION public.recalculate_collection_date_units()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_date_ids uuid[];
  v_date_id  uuid;
  v_pool_id  uuid;
  v_date     date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_date_ids := ARRAY[NEW.collection_date_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_date_ids := ARRAY[OLD.collection_date_id];
  ELSE
    -- UPDATE: if the row moved between dates we must recalc both.
    IF OLD.collection_date_id IS DISTINCT FROM NEW.collection_date_id THEN
      v_date_ids := ARRAY[OLD.collection_date_id, NEW.collection_date_id];
    ELSE
      v_date_ids := ARRAY[NEW.collection_date_id];
    END IF;
  END IF;

  FOREACH v_date_id IN ARRAY v_date_ids LOOP
    SELECT ca.capacity_pool_id, cd.date
    INTO v_pool_id, v_date
    FROM collection_date cd
    JOIN collection_area ca ON ca.id = cd.collection_area_id
    WHERE cd.id = v_date_id;

    IF v_pool_id IS NULL THEN
      UPDATE collection_date cd
      SET
        bulk_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          WHERE bi.collection_date_id = cd.id
          AND c.code = 'bulk'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        anc_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          WHERE bi.collection_date_id = cd.id
          AND c.code = 'anc'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        id_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          WHERE bi.collection_date_id = cd.id
          AND c.code = 'id'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        )
      WHERE cd.id = v_date_id;

      UPDATE collection_date
      SET
        bulk_is_closed = (bulk_units_booked >= bulk_capacity_limit),
        anc_is_closed  = (anc_units_booked  >= anc_capacity_limit),
        id_is_closed   = (id_units_booked   >= id_capacity_limit)
      WHERE id = v_date_id;
    ELSE
      UPDATE collection_date_pool cdp
      SET
        bulk_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
          JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
          WHERE ca2.capacity_pool_id = v_pool_id
          AND cd2.date = v_date
          AND c.code = 'bulk'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        anc_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
          JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
          WHERE ca2.capacity_pool_id = v_pool_id
          AND cd2.date = v_date
          AND c.code = 'anc'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        ),
        id_units_booked = (
          SELECT COALESCE(SUM(bi.no_services), 0)
          FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN service s ON s.id = bi.service_id
          JOIN category c ON c.id = s.category_id
          JOIN collection_date cd2 ON cd2.id = bi.collection_date_id
          JOIN collection_area ca2 ON ca2.id = cd2.collection_area_id
          WHERE ca2.capacity_pool_id = v_pool_id
          AND cd2.date = v_date
          AND c.code = 'id'
          AND b.status NOT IN ('Cancelled', 'Pending Payment')
        )
      WHERE cdp.capacity_pool_id = v_pool_id AND cdp.date = v_date;

      UPDATE collection_date_pool
      SET
        bulk_is_closed = (bulk_units_booked >= bulk_capacity_limit),
        anc_is_closed  = (anc_units_booked  >= anc_capacity_limit),
        id_is_closed   = (id_units_booked   >= id_capacity_limit)
      WHERE capacity_pool_id = v_pool_id AND date = v_date;
    END IF;
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
