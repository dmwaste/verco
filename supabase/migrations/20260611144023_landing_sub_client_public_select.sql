-- verco.au landing page member-council recognition list.
--
-- The root landing's council picker shows one card per client. For a
-- multi-council client like Verge Valet (WMRC), residents identify by their
-- own LGA ("City of Fremantle"), not the umbrella brand — so the card lists
-- its active member councils as a recognition aid. That needs anon read on
-- sub_client, which today is gated to staff only:
--
--   sub_client_select: client_id IN (SELECT accessible_client_ids())
--
-- accessible_client_ids() is empty for anon, so the landing query returns
-- nothing. Add a permissive public-SELECT policy for ACTIVE rows only.
--
-- Safe to expose: sub_client holds council names + codes — public LGA
-- information WMRC already publishes openly. No PII, no contact data. This
-- mirrors the existing public-SELECT tables (client, collection_area, etc.)
-- per CLAUDE.md §12. is_active gates out councils that are configured but not
-- yet launched.
--
-- Permissive policies are OR'd, so staff keep their existing scoped access
-- and additionally gain active-row read (harmless — public names).

CREATE POLICY "sub_client_public_select_active"
  ON public.sub_client
  FOR SELECT
  TO anon, authenticated
  USING (is_active = true);
