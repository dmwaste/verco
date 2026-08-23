-- booking_survey staff SELECT/DELETE: hoist the stable helper calls into
-- InitPlans (CLAUDE.md §21 "DB objects" — bare is_*()/current_user_*() in a
-- USING clause re-evaluates per row; `(select …)` runs once per statement).
-- Same predicate as 20260823200000, only the evaluation shape changes.

DROP POLICY IF EXISTS booking_survey_staff_select ON public.booking_survey;
CREATE POLICY booking_survey_staff_select ON public.booking_survey
  FOR SELECT
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (
      (SELECT is_client_staff())
      OR (SELECT current_user_role()) = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role])
    )
    AND user_sub_client_allows_area(collection_area_id)
  );

DROP POLICY IF EXISTS booking_survey_staff_delete ON public.booking_survey;
CREATE POLICY booking_survey_staff_delete ON public.booking_survey
  FOR DELETE
  USING (
    client_id IN (SELECT accessible_client_ids())
    AND (
      (SELECT is_client_staff())
      OR (SELECT current_user_role()) = ANY (ARRAY['contractor-admin'::app_role, 'contractor-staff'::app_role])
    )
    AND user_sub_client_allows_area(collection_area_id)
  );
