-- Record that get_property_fy_usage deliberately counts soft-deleted bookings (ADR 0042).
--
-- Every billing and report path excludes booking.deleted_at IS NOT NULL
-- (get_client_monthly_report, get_booking_tally, get_reports_monthly,
-- dmops_export.*). FY usage does not, and that is correct: deleted_at means
-- "exclude from billing and reporting", not "not collected". The 91 VV bookings
-- soft-deleted 08/09/2026 were completed August collections already invoiced
-- via the Airtable leg; excluding them from usage would give 35 at-cap
-- residents a second free collection. A soft-deleted booking that genuinely
-- was not collected gets its allocation back via allocation_override.
--
-- Comment-only: the function body, grants and search_path pin are unchanged.
-- COMMENT replaces the whole text, so the 20260724000000 comment is carried
-- forward verbatim with one sentence added after the exclusion list.

comment on function public.get_property_fy_usage(uuid, uuid, uuid) is
  'PII-free FY-usage counts (SUM(no_services)) per service_id and per category code for a property, plus a (''swap'', <conversion_rule_id>, 1) row when the property has an applied allocation swap this FY (suppressed when the swap''s own booking is excluded). Used by the /book wizard preview, the confirm-page breakdown, the address-lookup allocation panel, and the create-booking price re-validation so allocation is enforced identically regardless of caller identity (the services step runs pre-OTP as anon). Excludes Cancelled, Pending Payment and Rebooked (a rebook clone replaces its original 1:1). Deliberately still counts soft-deleted bookings (deleted_at): soft-delete removes a booking from billing and reports, not from what the resident received; return allocation for a booking that was genuinely not collected with allocation_override (ADR 0042). SECURITY DEFINER because booking/booking_item/allocation_swap are RLS-scoped; returns only aggregate counts and rule ids, never PII. Anon EXECUTE is intentional (public /book flow).';
