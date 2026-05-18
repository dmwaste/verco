-- resolve_booking_redirect — anon-callable lookup for the verco.au/b/<ref>
-- canonical SMS URL endpoint. Returns the tenant's custom_domain so the
-- root-host proxy can 302 the recipient to the right tenant subdomain.
--
-- All four RLS policies on `booking` require an authenticated role
-- (client-staff / contractor / field / resident), so the proxy's anon
-- client can't SELECT through normal channels. This SECURITY DEFINER
-- function bypasses RLS with a minimal projection (custom_domain +
-- is_active only — no PII, no booking content).
--
-- Exposure risk: anyone can probe whether a given ref exists. Mitigated
-- by the booking-ref shape (random 6-char suffix on a 3-char area code
-- = ~2.1B combinations) and the fact that custom_domain is already
-- public information. The redirect target itself enforces its own auth
-- to view booking contents.

CREATE OR REPLACE FUNCTION public.resolve_booking_redirect(p_ref text)
RETURNS TABLE(custom_domain text, is_active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.custom_domain, c.is_active
  FROM booking b
  JOIN client c ON c.id = b.client_id
  WHERE b.ref = p_ref;
$$;

COMMENT ON FUNCTION public.resolve_booking_redirect(text) IS
  'Anon-callable lookup for verco.au/b/<ref> SMS canonical URLs. Returns the bookings tenant custom_domain so the root-host proxy can 302 to the correct tenant subdomain. SECURITY DEFINER — projects only custom_domain + is_active (no PII).';

GRANT EXECUTE ON FUNCTION public.resolve_booking_redirect(text) TO anon, authenticated;
