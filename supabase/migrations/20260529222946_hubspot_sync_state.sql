-- hubspot_sync_state: per-entity (updated_at, id) keyset cursor for the sync-to-hubspot
-- Edge Function, plus a last-run outcome summary. VER-238.
-- Spec: docs/superpowers/specs/2026-05-29-verco-hubspot-sync-design.md §3 / §7.
--
-- The run-outcome columns (last_run_at / last_error / last_rows_synced) are the VISIBLE
-- failure signal: the cron invokes the EF via net.http_post (pg_net) which is fire-and-forget,
-- so the EF's HTTP 500 lands async in net._http_response and is invisible in cron.job_run_details.
-- The EF therefore records each run here (eng-review F4).

-- ─── Cursor + run-state table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hubspot_sync_state (
  entity            text PRIMARY KEY
                      CHECK (entity IN ('contacts', 'booking', 'service_ticket')),
  cursor_updated_at timestamptz,                       -- NULL = epoch start (full backfill)
  cursor_id         uuid,                              -- last synced row id at cursor_updated_at
  last_run_at       timestamptz,                       -- run outcome (visible signal) ↓
  last_error        text,
  last_rows_synced  integer,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE hubspot_sync_state IS
  'Per-entity keyset cursor + last-run outcome for the sync-to-hubspot Edge Function (VER-238). Written by the EF via service role; readable by contractor staff for observability.';

-- Seed the three entities at epoch (NULL cursor → full backfill on first run).
INSERT INTO hubspot_sync_state (entity)
  VALUES ('contacts'), ('booking'), ('service_ticket')
  ON CONFLICT (entity) DO NOTHING;

-- updated_at maintenance (project convention). Safe here: this table is NOT a cursor
-- source, so the unconditional handle_updated_at() cannot cause a re-sync loop.
DROP TRIGGER IF EXISTS hubspot_sync_state_updated_at ON hubspot_sync_state;
CREATE TRIGGER hubspot_sync_state_updated_at
  BEFORE UPDATE ON hubspot_sync_state
  FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

-- Deliberate CLAUDE.md §21 deviation: NO audit_trigger_fn() here. This is a high-frequency,
-- service-role-only cursor table; auditing every cron advance would flood audit_log with no
-- user-meaningful signal. The PII-export audit is a separate concern (VER-241).

-- ─── RLS: contractor staff read-only; only the service-role EF writes ──────

ALTER TABLE hubspot_sync_state ENABLE ROW LEVEL SECURITY;

-- Contractor staff may READ sync state (observability dashboard / debugging).
-- No authenticated write policies → writes are service-role only (bypasses RLS). Default-deny.
DROP POLICY IF EXISTS hubspot_sync_state_contractor_select ON hubspot_sync_state;
CREATE POLICY hubspot_sync_state_contractor_select ON hubspot_sync_state
  FOR SELECT TO authenticated
  USING (current_user_role() IN ('contractor-admin', 'contractor-staff'));

-- ─── Keyset indexes for the (updated_at, id) cursor scan ───────────────────
-- Support the EF's `WHERE (updated_at, id) > cursor ORDER BY updated_at, id LIMIT N`.
CREATE INDEX IF NOT EXISTS idx_contacts_keyset       ON contacts(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_booking_keyset        ON booking(updated_at, id);
CREATE INDEX IF NOT EXISTS idx_service_ticket_keyset ON service_ticket(updated_at, id);
-- (contact_id indexes for the contacts EXISTS(booking OR ticket) scope predicate already
--  exist: idx_booking_contact, idx_service_ticket_contact.)
