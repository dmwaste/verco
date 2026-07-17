-- Make the capacity-counter trigger SECURITY DEFINER — counters must move for
-- every write path, not just contractor-admin sessions.
--
-- recalculate_collection_date_units (AFTER INSERT/UPDATE/DELETE on booking_item)
-- was SECURITY INVOKER, so its UPDATEs of collection_date / collection_date_pool
-- ran under the calling user's RLS. The only write policies on those tables are
-- contractor-admin (`collection_date_contractor_write`,
-- `collection_date_pool_contractor_admin_all`), so a booking_item write by
-- contractor-staff / client-admin / client-staff fired the trigger against
-- ZERO visible rows — no error, counters silently stale, and *_is_closed never
-- recomputed. Until 20260717014018 this was mostly latent (item INSERTs came
-- via service-role EFs or DEFINER RPCs; the exception was the direct
-- booking_item_staff_update path, 20260515055645). The staff INSERT policies
-- shipped in this same release make it live for the NCN/NP rebook path: 3 of
-- the 4 staff tiers granted would have created bookings whose capacity was
-- never counted, silently overbooking caps (e.g. the KWN ID 2/day cap in
-- 20260716000000).
--
-- DEFINER is this function's documented intent — 20260513080000 (capacity_pool)
-- states "Counter updates happen via SECURITY DEFINER functions (RPC + trigger)".
-- The function writes only derived counter/closed columns, reads nothing
-- caller-controlled beyond the NEW/OLD row, and gains a pinned search_path per
-- repo convention (ALTER ... SET survives future CREATE OR REPLACE only if
-- re-declared there — keep the pin in any future redefinition).

ALTER FUNCTION public.recalculate_collection_date_units() SECURITY DEFINER;
ALTER FUNCTION public.recalculate_collection_date_units() SET search_path = public, pg_temp;
