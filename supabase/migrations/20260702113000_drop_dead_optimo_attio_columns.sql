-- Drop five dead columns (repo prune, 02/07/2026).
--
-- booking.optimo_stop_id: placeholder from the original OptimoRoute design,
-- never read or written — stops carry their OR reference on
-- collection_stop.external_order_ref instead.
--
-- contacts.attio_person_id / attio_person_web_url,
-- service_ticket.attio_record_id, sync_log.attio_record_id: leftovers from
-- the abandoned Attio CRM integration (direction changed to HubSpot,
-- 29/05/2026 — the attio-* EFs in the original tech spec were never built).
--
-- Pre-drop verification (prod, 02/07/2026): all five columns 0 non-null rows;
-- zero audit_log snapshots carry them; no views, functions, or indexes depend
-- on them (pg_depend / pg_proc / pg_indexes all empty). field-labels cleanup
-- rides this PR; types.ts regen happens post-release per the PR-A → release →
-- PR-B flow.

-- booking is the hottest table: DROP COLUMN needs ACCESS EXCLUSIVE, and while
-- the ALTER queues behind a long-running reader, every booking read/write
-- queues behind the ALTER. Bound the wait: a timeout fails db push (which
-- skips the Coolify deploy — the known runbook), and IF EXISTS makes the
-- retry clean.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.booking DROP COLUMN IF EXISTS optimo_stop_id;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS attio_person_id;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS attio_person_web_url;
ALTER TABLE public.service_ticket DROP COLUMN IF EXISTS attio_record_id;
ALTER TABLE public.sync_log DROP COLUMN IF EXISTS attio_record_id;
