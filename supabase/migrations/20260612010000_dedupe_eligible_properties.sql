-- Dedupe eligible_properties — removes the duplicate-import rows that made
-- ~1,000 eligible Verge Valet addresses report as "not eligible" in the public
-- booking flow (the lookup's .maybeSingle() / length===1 guards bail on >1 row).
--
-- Root cause: a batch import created rows whose `address` carried the wrong
-- suburb/area (mostly "<n> St PERTH" → Vincent), which Google geocoded to the
-- real suburb — spawning a second copy of the property under a different
-- collection area. Plus same-area double-imports and some junk/template rows.
--
-- Verified end-to-end against prod inside a rolled-back transaction
-- (2026-06-12): before=848 dup groups → 20 place_ids nulled, 1,024 rows deleted
-- → remaining_dupe_groups = 0. NONE of the affected rows have any booking
-- (FK-safe); every DELETE is guarded with a no-bookings NOT EXISTS regardless.
--
-- The companion code change (PR: address-search-dupes-wa-filter) hardens the
-- lookup so a FUTURE duplicate import never silently re-breaks eligibility.

-- ── Phase A ──────────────────────────────────────────────────────────────────
-- Neutralise the junk country-level place_id. ChIJ38WHZwf9KysRUhNblaFnglM is
-- Google's place_id for "Australia" — rows carrying it failed to geocode
-- (formatted_address = 'Australia'). Null the place_id so genuinely-distinct
-- un-geocoded addresses (e.g. "17 Daisy La, Como") stop sharing a phantom key;
-- the geocode EF will re-resolve them. Verified: all 20 such rows are 'Australia'.
update eligible_properties
set google_place_id = null
where google_place_id = 'ChIJ38WHZwf9KysRUhNblaFnglM'
  and formatted_address = 'Australia';

-- ── Phase B ──────────────────────────────────────────────────────────────────
-- Delete template / test junk rows left in prod.
delete from eligible_properties ep
where ep.address in (
        'Delete Me',
        'House No. Street Name Street Type Suburb',
        'House_Number Street_Name_sep Street_Type_sep Suburb'
      )
  and not exists (select 1 from booking b where b.property_id = ep.id);

-- ── Phase C ──────────────────────────────────────────────────────────────────
-- Same-area exact duplicates: same (client, place_id) imported 2+ times into the
-- SAME collection area. Keep the earliest row, delete the rest.
delete from eligible_properties ep
using (
  select e.id,
         row_number() over (
           partition by ca.client_id, e.google_place_id, e.collection_area_id
           order by e.created_at asc, e.id asc
         ) as rn
  from eligible_properties e
  join collection_area ca on ca.id = e.collection_area_id
  where e.google_place_id is not null
    and not exists (select 1 from booking b where b.property_id = e.id)
) d
where ep.id = d.id and d.rn > 1;

-- ── Phase D1 ─────────────────────────────────────────────────────────────────
-- Cross-area duplicates: the same place_id mapped to two DIFFERENT collection
-- areas under one client. The mis-sourced row is the one whose geocoded suburb
-- (derived from formatted_address) does not appear in its `address` text — e.g.
-- "6 Grant ST PERTH" (Vincent) vs the real "6 Grant St, Cottesloe". Delete it;
-- the correctly-suburbed row survives. The two genuine LGA-boundary exceptions
-- (Mount Hawthorn, North Fremantle) match on suburb and are left for Phase D2.
delete from eligible_properties ep
using collection_area ca
where ca.id = ep.collection_area_id
  and ep.google_place_id is not null
  and ep.formatted_address <> 'Australia'
  and not exists (select 1 from booking b where b.property_id = ep.id)
  and exists (
    select 1
    from eligible_properties e2
    join collection_area c2 on c2.id = e2.collection_area_id
    where e2.google_place_id = ep.google_place_id
      and c2.client_id = ca.client_id
      and c2.id <> ep.collection_area_id
  )
  and position(
        lower(trim(regexp_replace(split_part(ep.formatted_address, ',', 2), '\s+WA\s+\d+.*$', '')))
        in lower(ep.address)
      ) = 0;

-- ── Phase D2 ─────────────────────────────────────────────────────────────────
-- Confirmed LGA-boundary exceptions (Dan, 2026-06-12). Both keep the row whose
-- area actually services the suburb and delete the mis-imported Fremantle—South
-- copy:
--   • 56A Milton St → Mount Hawthorn is in City of Vincent → keep Vincent.
--   • 6 Tasker Pl   → North Fremantle → keep Fremantle—North.
delete from eligible_properties ep
using collection_area ca
where ca.id = ep.collection_area_id
  and ca.name = 'Fremantle — South'
  and ep.google_place_id in (
        'ChIJpU7ZEYuvMioRbHudTSDih70', -- 56A Milton St, Mount Hawthorn
        'ChIJV-mZaFWhMioRW91wejF6ak0'  -- 6 Tasker Pl, North Fremantle
      )
  and not exists (select 1 from booking b where b.property_id = ep.id);
