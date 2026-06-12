-- list-vv-airtable-dupes.sql
--
-- Lists the Airtable records behind the duplicate eligible_properties rows that
-- the dedupe migration (20260612010000_dedupe_eligible_properties.sql) removes.
-- Run this against the Verco Supabase project to get a current, actionable list
-- of Airtable records to delete at source (so the duplicates don't re-accrue).
--
-- Columns: airtable_base (= the Airtable base id), airtable_record_id (delete
-- THIS record in Airtable), address, assigned_area, reason.
-- Rows with a blank airtable_base came from non-Airtable imports (KWN/DM-Ops) —
-- they are cleaned in Verco by the migration; nothing to do in Airtable.
--
-- NOTE: the importer guard in scripts/import-vv-properties.ts (dedupeByPlaceId)
-- already prevents these from re-importing, so this cleanup is source hygiene,
-- not a hard dependency. Keeps the "keep" copy (correct council/area) and lists
-- only the redundant/mis-sourced copy for deletion.

with del as (
  -- Template / test junk rows
  select ep.id, 'B_template' as reason
  from eligible_properties ep
  where ep.address in (
          'Delete Me',
          'House No. Street Name Street Type Suburb',
          'House_Number Street_Name_sep Street_Type_sep Suburb'
        )
    and not exists (select 1 from booking b where b.property_id = ep.id)
  union
  -- Same-area duplicates: keep earliest per (client, place_id, area), list the rest
  select s.id, 'C_same_area'
  from (
    select e.id,
           row_number() over (
             partition by ca.client_id, e.google_place_id, e.collection_area_id
             order by e.created_at, e.id
           ) rn
    from eligible_properties e
    join collection_area ca on ca.id = e.collection_area_id
    where e.google_place_id is not null
      and not exists (select 1 from booking b where b.property_id = e.id)
  ) s
  where s.rn > 1
  union
  -- Cross-area mis-source: the row whose geocoded suburb is absent from its address
  select ep.id, 'D1_cross_area'
  from eligible_properties ep
  join collection_area ca on ca.id = ep.collection_area_id
  where ep.google_place_id is not null
    and ep.formatted_address <> 'Australia'
    and not exists (select 1 from booking b where b.property_id = ep.id)
    and exists (
      select 1 from eligible_properties e2
      join collection_area c2 on c2.id = e2.collection_area_id
      where e2.google_place_id = ep.google_place_id
        and c2.client_id = ca.client_id
        and c2.id <> ep.collection_area_id
    )
    and position(
          lower(trim(regexp_replace(split_part(ep.formatted_address, ',', 2), '\s+WA\s+\d+.*$', '')))
          in lower(ep.address)
        ) = 0
  union
  -- Confirmed LGA-boundary exceptions: delete the mis-imported Fremantle—South copy
  -- (keep Vincent for Mount Hawthorn; keep Fremantle—North for North Fremantle)
  select ep.id, 'D2_exception'
  from eligible_properties ep
  join collection_area ca on ca.id = ep.collection_area_id
  where ca.name = 'Fremantle — South'
    and ep.google_place_id in (
          'ChIJpU7ZEYuvMioRbHudTSDih70', -- 56A Milton St, Mount Hawthorn
          'ChIJV-mZaFWhMioRW91wejF6ak0'  -- 6 Tasker Pl, North Fremantle
        )
    and not exists (select 1 from booking b where b.property_id = ep.id)
)
select
  split_part(ep.external_source, ':', 2) as airtable_base,
  ep.external_id                          as airtable_record_id,
  ep.address,
  ca.name                                 as assigned_area,
  del.reason
from del
join eligible_properties ep on ep.id = del.id
join collection_area ca on ca.id = ep.collection_area_id
where ep.external_source like 'airtable:%'   -- Airtable records only (drop KWN/DM-Ops rows)
order by airtable_base, del.reason, ep.address;
