-- Field/ranger mobile (plan 2026-06-10) — A3: NCN/NP → collection_stop link.
--
-- With per-stream stops, an exception is raised against ONE stream of a
-- booking (e.g. green contaminated, general collected fine). The stop
-- reference lets resident comms name the failed stream and lets the admin
-- rebook flow clone only the failed stream's items instead of the whole
-- booking. Nullable: legacy rows and the transitional per-booking path keep
-- NULL (= whole-booking semantics).
--
-- No RLS changes needed: NCN/NP policies are row-scoped, and
-- collection_stop_select (transitive on booking) already resolves embeds for
-- every role that can see the notice.

ALTER TABLE non_conformance_notice
  ADD COLUMN collection_stop_id uuid REFERENCES collection_stop(id);

CREATE INDEX idx_ncn_collection_stop
  ON non_conformance_notice(collection_stop_id);

COMMENT ON COLUMN non_conformance_notice.collection_stop_id IS
  'The stop (booking × stream) this NCN was raised against. NULL = raised '
  'per-booking (legacy path / bookings without stops).';

ALTER TABLE nothing_presented
  ADD COLUMN collection_stop_id uuid REFERENCES collection_stop(id);

CREATE INDEX idx_np_collection_stop
  ON nothing_presented(collection_stop_id);

COMMENT ON COLUMN nothing_presented.collection_stop_id IS
  'The stop (booking × stream) this NP was raised against. NULL = raised '
  'per-booking (legacy path / bookings without stops).';
