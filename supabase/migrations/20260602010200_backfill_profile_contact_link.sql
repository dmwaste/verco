-- F4 (VER-248): backfill profiles.contact_id for accounts linked by email.
--
-- Residents who authenticated via OTP *login* (not the guest-OTP-at-booking
-- flow) ended up with profiles.contact_id = NULL: the booking confirm flow
-- forwarded only the anon key to create-booking, so its auth.getUser() resolved
-- nobody and the existing profile->contact link (create-booking/index.ts) never
-- ran. That made create-checkout 403 ("Booking does not belong to this user")
-- and hid the resident's own bookings from their dashboard.
--
-- The client now forwards the session JWT (confirm-form.tsx), so new bookings
-- link on creation. This one-off backfills the existing NULL rows — but ONLY
-- when exactly one contact matches the profile's email, so we never guess on a
-- duplicated email. Idempotent: it only touches rows that are still NULL.

UPDATE public.profiles p
SET contact_id = c.id
FROM public.contacts c
WHERE p.contact_id IS NULL
  AND p.email IS NOT NULL
  AND lower(c.email) = lower(p.email)
  AND (
    SELECT count(*) FROM public.contacts c2
    WHERE lower(c2.email) = lower(p.email)
  ) = 1;
