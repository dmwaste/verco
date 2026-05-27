-- Add a SELECT policy on `contacts` for admin roles to see strata contacts
-- attached to MUD properties in their tenant scope.
--
-- ── Why ─────────────────────────────────────────────────────────────────
-- The existing `contacts` SELECT policies only cover contacts that are
-- referenced by `booking.contact_id` or `profiles.contact_id`. Strata
-- contacts created via the MUD import (PR #87, scripts/import-mud-properties.ts
-- + scripts/import-kwn-mud-properties.ts) live on `eligible_properties.
-- strata_contact_id` and are not yet referenced by any booking or profile.
-- Result: admins query `/admin/muds`, `/admin/properties/[id]`,
-- `/admin/bookings/[id]` (MUD context card), and the strata-contact embed
-- silently returns null even though 352 of 438 prod MUD rows have valid
-- contact data.
--
-- Same shape of gap as `strata_user_properties` admin RLS (file
-- 20260522042858) — data plumbing built ahead of policy coverage. This
-- closes the analogous gap on the strata-contact-on-property facet.
--
-- ── Scope ───────────────────────────────────────────────────────────────
-- Tenant-scoped via the `collection_area.client_id` / `contractor_id`
-- path so admins only see strata contacts for MUD properties in their
-- own tenant. No broader than the existing `contacts_*_select` policies.
--
-- Additive — does not replace or weaken existing PII protections. Field
-- and ranger roles still receive zero contact info (CLAUDE.md §4 holds).

CREATE POLICY contacts_admin_strata_select ON contacts
  FOR SELECT
  USING (
    current_user_role() IN (
      'contractor-admin'::app_role,
      'contractor-staff'::app_role,
      'client-admin'::app_role,
      'client-staff'::app_role
    )
    AND EXISTS (
      SELECT 1
      FROM eligible_properties ep
      JOIN collection_area ca ON ca.id = ep.collection_area_id
      WHERE ep.strata_contact_id = contacts.id
        AND (
          (current_user_role() IN ('contractor-admin'::app_role, 'contractor-staff'::app_role)
            AND ca.contractor_id = current_user_contractor_id())
          OR
          (current_user_role() IN ('client-admin'::app_role, 'client-staff'::app_role)
            AND ca.client_id = ANY(accessible_client_ids()))
        )
    )
  );
