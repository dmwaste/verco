-- Lock down update_booking_items_in_place to service_role only.
--
-- Its ONLY production caller is the create-booking EF, which invokes it via the
-- SERVICE-ROLE client (supabase/functions/create-booking/index.ts). Verified: rg
-- for the function name across src/ and supabase/ finds exactly one .rpc() call
-- site — that one, running as service_role — plus doc comments; no user-JWT path
-- calls it.
--
-- The RPC trusts unit_price_cents / is_extra VERBATIM from p_items and writes
-- them straight onto booking_item — it is the pricing engine's server-side write,
-- not a re-validating boundary. Postgres grants EXECUTE to PUBLIC on creation,
-- and 20260712000000 additionally granted anon + authenticated, so it is
-- currently callable via PostgREST /rpc/ by any resident/staff JWT. It is
-- SECURITY INVOKER, so today its writes are still RLS-gated (no resident-tier
-- booking_item write policy exists) — but the moment any future migration adds
-- such a policy, this RPC silently becomes a pricing-engine bypass: a resident
-- could POST /rpc/update_booking_items_in_place with client-chosen prices and
-- never hit the server-side recalculation. Close the door now.
--
-- 7-arg signature (post-20260712000000, p_expected_items added). This is a grant
-- change only — the function body is untouched. service_role does NOT inherit the
-- PUBLIC grant once revoked (it is a peer role, not a superuser), so re-grant it
-- explicitly to keep the create-booking EF working.

REVOKE EXECUTE ON FUNCTION public.update_booking_items_in_place(uuid, uuid, jsonb, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_booking_items_in_place(uuid, uuid, jsonb, uuid, text, text, jsonb)
  TO service_role;
