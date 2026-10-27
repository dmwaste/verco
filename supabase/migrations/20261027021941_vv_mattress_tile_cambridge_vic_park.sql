-- WMRC copy request (Jared Crowe, 26/10/2026): the Verge Valet home page's
-- "What we collect" Mattress tile promotes mattress collections to every
-- council, but Town of Cambridge (CAM-A/CAM-B) and Town of Victoria Park (VIC)
-- residents are not eligible: neither area has a Mattress service rule, and
-- the VV FAQ already says mattresses are not accepted there.
--
-- Data only, no schema change. The tile copy lives in client.service_descriptions
-- (per-tenant override map, migration 20260729031234; no admin UI), so this
-- adds the Mattress key for Verge Valet and leaves every other council's
-- mattress promotion as it is. Keyed on slug so a fresh `db reset` (clients
-- not migration-seeded) no-ops; predicated so a re-run, or a value someone has
-- since set by hand, is left alone.

UPDATE public.client
SET service_descriptions = service_descriptions
      || jsonb_build_object(
        'Mattress',
        'Bed mattresses of any size — single, double, queen, king. Not available to Town of Cambridge or Town of Victoria Park residents.'
      )
WHERE slug = 'vergevalet'
  AND NOT service_descriptions ? 'Mattress';
