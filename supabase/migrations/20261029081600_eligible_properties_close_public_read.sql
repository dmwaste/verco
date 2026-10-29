-- Close the property register to anonymous callers and residents
-- (29/10/2026 SECURITY DEFINER review, fix B step 3 of 3).
--
-- PRECONDITION: step 2 is live on prod — address-form.tsx, calculate-price and
-- create-booking read properties through lookup_eligible_properties() /
-- get_property_for_booking() (20261029081500), not the table. Released before
-- that, /book reports every address as "not eligible" until the app catches up.
--
-- Before this migration (both policies TO public, OR'd):
--   * eligible_properties_public_select — every row whenever
--     current_user_sub_client_id() IS NULL: all ~110k rows, every column, to
--     anyone holding the public anon key, and to every resident.
--   * eligible_properties_select — the caller's whole client whenever their
--     user_roles row has a client_id: staff, and ~1,300 residents.
--
-- After (both TO authenticated — anon gets no policy, so zero rows):
--   * eligible_properties_select — staff, field and ranger roles only, by
--     tenant (accessible_client_ids) with ADR 0019's sub-client narrowing.
--     Staff lose nothing they use: every admin/field reader already pins the
--     tenant (VER-281) — the cross-tenant rows public_select also handed them
--     were never meant to be visible.
--   * eligible_properties_own_select (was public_select) — a resident or strata
--     user reads only the properties of their own bookings (+ a strata user's
--     authorised MUDs), which is what /dashboard, /booking/[ref] and
--     /contact/tickets/[id] embed. current_user_property_ids() is empty for
--     every staff role, so this branch can't widen a sub-client-scoped user
--     (§21: policies OR — no bare branch may re-open the leak).
--
-- ALTER rather than DROP + CREATE: the policy swap is atomic and there is no
-- moment without a SELECT policy.

alter policy eligible_properties_select on public.eligible_properties
  to authenticated
  using (
    (select public.current_user_role()) in (
      'contractor-admin', 'contractor-staff', 'field',
      'client-admin', 'client-staff', 'ranger'
    )
    and collection_area_id in (
      select ca.id from public.collection_area ca
      where ca.client_id in (select public.accessible_client_ids())
    )
    and (
      (select public.current_user_sub_client_id()) is null
      or collection_area_id in (
        select ca.id from public.collection_area ca
        where ca.sub_client_id = (select public.current_user_sub_client_id())
      )
    )
  );

alter policy eligible_properties_public_select on public.eligible_properties
  rename to eligible_properties_own_select;

alter policy eligible_properties_own_select on public.eligible_properties
  to authenticated
  using (id in (select public.current_user_property_ids()));
