-- BR-0035 (#557): strip Google named-premise prefixes from stored
-- eligible_properties.formatted_address on the Verge Valet tenant.
--
-- Google's Geocoding API returns strata addresses as
--   "<Premise Name>, Unit 1/504 Stirling Hwy, Peppermint Grove WA 6011, Australia"
-- and the write-time stripper in the geocode-properties EF only removed a
-- leading unit WORD, so the premise name survived into formatted_address.
-- The booking flow's eligibility lookup prefix-matches formatted_address
-- (start-anchored ILIKE, address-match-key.ts), which requires the stored
-- value to START with the house number — so residents of ~1,100 VV unit
-- properties were told their address is "not eligible".
--
-- This is the pure-string backfill companion to the EF fix (stripPremisePrefix
-- in _shared/geocode-verify.ts) — same transformation, no Geocoding API calls.
-- Scoped to Verge Valet: KWN formatted_address values came through different
-- import paths and show no premise-prefix rows; a blanket rewrite there risks
-- false positives for zero benefit.
--
-- Reset-safety (CLAUDE.md §21): every UPDATE is conditional on matching rows
-- under the 'vergevalet' client — on a fresh `db reset` (no such client/rows)
-- both statements are no-ops.

-- Shape 1: named-premise prefix — "<Premise Name>, <street address>, …".
-- Drop the leading segment only when it does not itself start with a house
-- number or a unit-word-then-number, AND the following segment is
-- recognisably the street address (starts with a number, or a unit word
-- followed by a unit number). Then strip any now-leading unit word.
-- Mirrors stripPremisePrefix() in supabase/functions/_shared/geocode-verify.ts.
UPDATE eligible_properties ep
SET formatted_address = regexp_replace(
      regexp_replace(ep.formatted_address, '^[^,]*,\s*', ''),
      '^(Unit|Flat|Townhouse|Apartment|Suite|Apt|Villa)\s+([0-9]|[A-Za-z]{1,2}/)',
      '\2',
      'i'
    ),
    updated_at = now()
FROM collection_area ca
WHERE ca.id = ep.collection_area_id
  AND ca.client_id = (SELECT id FROM client WHERE slug = 'vergevalet')
  AND ep.formatted_address IS NOT NULL
  AND ep.formatted_address ~ ','
  AND btrim(split_part(ep.formatted_address, ',', 1)) <> ''
  AND btrim(split_part(ep.formatted_address, ',', 1)) !~ '^[0-9]'
  AND btrim(split_part(ep.formatted_address, ',', 1))
      !~* '^(unit|flat|townhouse|apartment|suite|apt|villa)\s+([0-9]|[a-z]{1,2}/)'
  AND btrim(split_part(ep.formatted_address, ',', 2))
      ~* '^([0-9]|(unit|flat|townhouse|apartment|suite|apt|villa)\s+([0-9]|[a-z]{1,2}/))';

-- Shape 2: bare unit-word prefix — "Villa 1/5 Salvado St, …". The legacy
-- write-time strip never knew "Villa", so a small residue of these exists.
UPDATE eligible_properties ep
SET formatted_address = regexp_replace(
      ep.formatted_address,
      '^(Unit|Flat|Townhouse|Apartment|Suite|Apt|Villa)\s+([0-9]|[A-Za-z]{1,2}/)',
      '\2',
      'i'
    ),
    updated_at = now()
FROM collection_area ca
WHERE ca.id = ep.collection_area_id
  AND ca.client_id = (SELECT id FROM client WHERE slug = 'vergevalet')
  AND ep.formatted_address ~* '^(unit|flat|townhouse|apartment|suite|apt|villa)\s+([0-9]|[a-z]{1,2}/)';

-- Post-condition (invariant, not a hardcoded count): no VV row this migration
-- targeted may remain premise-prefixed. Rows whose geocode has no house
-- number at all (street-only/suburb-only results — a separate data-quality
-- class) are deliberately out of scope and excluded by the same conditions.
DO $$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM eligible_properties ep
  JOIN collection_area ca ON ca.id = ep.collection_area_id
  WHERE ca.client_id = (SELECT id FROM client WHERE slug = 'vergevalet')
    AND ep.formatted_address IS NOT NULL
    AND (
      ep.formatted_address
        ~* '^(unit|flat|townhouse|apartment|suite|apt|villa)\s+([0-9]|[a-z]{1,2}/)'
      OR (
        ep.formatted_address ~ ','
        AND btrim(split_part(ep.formatted_address, ',', 1)) <> ''
        AND btrim(split_part(ep.formatted_address, ',', 1)) !~ '^[0-9]'
        AND btrim(split_part(ep.formatted_address, ',', 2))
            ~* '^([0-9]|(unit|flat|townhouse|apartment|suite|apt|villa)\s+([0-9]|[a-z]{1,2}/))'
      )
    );
  IF remaining > 0 THEN
    RAISE EXCEPTION 'BR-0035 backfill left % premise-prefixed VV rows', remaining;
  END IF;
END $$;
