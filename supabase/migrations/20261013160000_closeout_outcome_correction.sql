-- Office correction of a crew's wrong closeout (ADR 0030).
--
-- Crews occasionally tap Completed when the job was a non-conformance (or the
-- reverse). Terminal stop statuses were immutable for EVERY writer, and
-- Completed had no outgoing booking transition, so the only fix was a
-- hand-edited prod database. This adds exactly one sanctioned path:
--
--   correct_stop_outcome(stop, to_status, reason, …)
--     • contractor-admin only (NULL-safe gate), tenant + sub-client pinned
--     • terminal → different terminal (Completed / Non-conformance /
--       Nothing Presented), within 7 days of the stop's DISPATCHED date
--       (ADR 0009: the stop's date is never changed, so a correction can't
--       launder a wrong-day miss into an on-time success)
--     • booking must still be Scheduled / Completed / NCN / NP — a Rebooked
--       booking has moved on and is not correctable
--     • moving AWAY from NCN/NP withdraws (deletes) the stop's notice, but
--       only while it is still Issued — a disputed / under-review notice
--       goes through the investigation flow instead. The deleted row's full
--       snapshot stays in audit_log; reports read the notice tables, so a
--       withdrawn notice must not linger under a new status
--     • moving TO NCN/NP raises a fresh Issued notice (new 14-day window),
--       carrying the withdrawn notice's photos across on an NCN ↔ NP swap
--     • every correction is logged in stop_outcome_correction (who, when,
--       from, to, why)
--
-- The carve-out in the three status triggers is keyed on a transaction-local
-- flag (verco.closeout_correction) that ONLY this SECURITY DEFINER function
-- sets, AND on current_user not being a PostgREST login role — inside the
-- definer, current_user is the function owner. A crew/staff JWT updating a
-- stop or booking directly can't reach set_config (pg_catalog isn't exposed
-- via PostgREST) and runs as `authenticated` regardless, so the old
-- immutability holds for everyone else, including the service role.
--
-- Resident comms are sent by the calling server action after this returns
-- (ncn_raised / np_raised / closeout_corrected) — never from SQL.

-- ── 1. Correction log ─────────────────────────────────────────────────────

CREATE TABLE public.stop_outcome_correction (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_stop_id  uuid NOT NULL REFERENCES public.collection_stop(id) ON DELETE CASCADE,
  booking_id          uuid NOT NULL REFERENCES public.booking(id) ON DELETE CASCADE,
  client_id           uuid NOT NULL REFERENCES public.client(id),
  from_status         public.stop_status NOT NULL,
  to_status           public.stop_status NOT NULL,
  reason              text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  -- The NCN/NP record withdrawn by this correction (row deleted; its snapshot
  -- is in audit_log) and the one raised by it. No FKs: either table, and a
  -- later correction may withdraw new_notice_id in turn.
  withdrawn_notice_id uuid,
  new_notice_id       uuid,
  corrected_by        uuid NOT NULL REFERENCES public.profiles(id),
  corrected_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stop_outcome_correction_changes_status CHECK (from_status <> to_status),
  CONSTRAINT stop_outcome_correction_terminal_only CHECK (
    from_status IN ('Completed', 'Non-conformance', 'Nothing Presented')
    AND to_status IN ('Completed', 'Non-conformance', 'Nothing Presented')
  )
);

CREATE INDEX idx_stop_outcome_correction_booking ON public.stop_outcome_correction(booking_id);
CREATE INDEX idx_stop_outcome_correction_stop ON public.stop_outcome_correction(collection_stop_id);

CREATE TRIGGER audit_stop_outcome_correction
  AFTER INSERT OR UPDATE OR DELETE ON public.stop_outcome_correction
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

ALTER TABLE public.stop_outcome_correction ENABLE ROW LEVEL SECURITY;

-- Contractor tier only (the free-text reason is internal D&M ops context).
-- No INSERT/UPDATE/DELETE policies: correct_stop_outcome is the only writer.
CREATE POLICY stop_outcome_correction_select ON public.stop_outcome_correction
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_user_role()) IN ('contractor-admin', 'contractor-staff')
    AND client_id IN (SELECT public.accessible_client_ids())
  );

-- ── 2. Stop state machine: correction carve-out ───────────────────────────
-- Body identical to 20260610010100 (verified against prod 13/10/2026) plus
-- the terminal → terminal branch.

CREATE OR REPLACE FUNCTION public.enforce_stop_state_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claims     jsonb;
  v_privileged boolean;
BEGIN
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_privileged := v_claims IS NULL OR v_claims->>'role' = 'service_role';

  IF NOT v_privileged THEN
    IF NEW.booking_id IS DISTINCT FROM OLD.booking_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.stream IS DISTINCT FROM OLD.stream
       OR NEW.collection_date_id IS DISTINCT FROM OLD.collection_date_id
       OR NEW.external_order_ref IS DISTINCT FROM OLD.external_order_ref THEN
      RAISE EXCEPTION 'Stop identity columns are immutable for non-service writers';
    END IF;
    IF NEW.completed_by IS DISTINCT FROM OLD.completed_by
       AND NEW.completed_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'completed_by must be the acting user';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'Cancelled' AND NEW.status = 'Pending' AND v_privileged THEN
      RETURN NEW; -- push-EF revival of a reappeared stream
    END IF;
    -- Office closeout correction (ADR 0030) — only inside correct_stop_outcome.
    IF OLD.status IN ('Completed', 'Non-conformance', 'Nothing Presented')
       AND NEW.status IN ('Completed', 'Non-conformance', 'Nothing Presented')
       AND current_setting('verco.closeout_correction', true) = 'on'
       AND current_user NOT IN ('authenticated', 'anon') THEN
      RETURN NEW;
    END IF;
    IF OLD.status <> 'Pending' THEN
      RAISE EXCEPTION 'Invalid stop transition: % → % (terminal stop statuses are immutable)',
        OLD.status, NEW.status;
    END IF;
    -- From Pending every other status is reachable; no further check needed.
  END IF;
  RETURN NEW;
END;
$$;

-- ── 3. Booking state machine: correction carve-out ────────────────────────
-- Body identical to 20260518005936 (verified against prod 13/10/2026) plus
-- the final WHEN.

CREATE OR REPLACE FUNCTION public.enforce_booking_state_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  valid boolean := false;
BEGIN
  valid := CASE
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Submitted'          THEN true
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Confirmed'          THEN true
    WHEN OLD.status = 'Pending Payment'   AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Submitted'         AND NEW.status = 'Confirmed'          THEN true
    WHEN OLD.status = 'Submitted'         AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Confirmed'         AND NEW.status = 'Scheduled'          THEN true
    WHEN OLD.status = 'Confirmed'         AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Completed'          THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Non-conformance'    THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Nothing Presented'  THEN true
    WHEN OLD.status = 'Scheduled'         AND NEW.status = 'Cancelled'          THEN true
    WHEN OLD.status = 'Non-conformance'   AND NEW.status = 'Rebooked'           THEN true
    WHEN OLD.status = 'Nothing Presented' AND NEW.status = 'Rebooked'           THEN true
    -- Office closeout correction (ADR 0030): the stop rollup re-derives the
    -- booking outcome inside correct_stop_outcome — never reachable otherwise.
    WHEN OLD.status IN ('Completed', 'Non-conformance', 'Nothing Presented')
     AND NEW.status IN ('Completed', 'Non-conformance', 'Nothing Presented')
     AND current_setting('verco.closeout_correction', true) = 'on'
     AND current_user NOT IN ('authenticated', 'anon')                         THEN true
    ELSE false
  END;

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid booking status transition: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 4. Rollup: re-derive an already-closed booking during a correction ────
-- Body identical to 20260827030000 except the final UPDATE's WHERE. Normal
-- closeouts still only roll up a Scheduled booking; during a correction the
-- booking may already be terminal, and is re-derived when the outcome moves
-- (IS DISTINCT FROM: an UPDATE OF status to the SAME value would still fire
-- the state machine and be rejected as X → X).

CREATE OR REPLACE FUNCTION public.rollup_booking_status_from_stops()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pending  integer;
  v_ncn      integer;
  v_np       integer;
  v_live     integer;  -- non-Cancelled terminal stops
  v_rollup   booking_status;
BEGIN
  -- Serialise rollups per booking. Without this, two crews closing the last
  -- two sibling stops concurrently each see the other as Pending in their
  -- READ COMMITTED snapshot, BOTH skip the rollup, and the booking strands
  -- in Scheduled forever (terminal stops are immutable, so nothing re-fires).
  -- After blocking here, the count statement below gets a fresh snapshot and
  -- sees the other transaction's committed terminal status. Same key scheme
  -- as the capacity RPCs.
  PERFORM pg_advisory_xact_lock(('x' || substr(NEW.booking_id::text, 1, 8))::bit(32)::bigint);

  SELECT
    count(*) FILTER (WHERE status = 'Pending'),
    count(*) FILTER (WHERE status = 'Non-conformance'),
    count(*) FILTER (WHERE status = 'Nothing Presented'),
    count(*) FILTER (WHERE status <> 'Cancelled')
  INTO v_pending, v_ncn, v_np, v_live
  FROM collection_stop
  WHERE booking_id = NEW.booking_id;

  IF v_pending > 0 OR v_live = 0 THEN
    RETURN NULL;  -- stops still open, or everything cancelled — nothing to roll up
  END IF;

  -- Outstanding-stream guard (see header): a booked stream with no live stop
  -- is a collection still owed — a date move cancelled its stop and the new
  -- date hasn't locked yet. Stay Scheduled so the push EF (Confirmed/Scheduled
  -- fetch) revives the stream's stop when the moved-to date locks.
  IF EXISTS (
    SELECT 1
    FROM booking_item bi
    JOIN service s ON s.id = bi.service_id
    WHERE bi.booking_id = NEW.booking_id
      AND NOT EXISTS (
        SELECT 1 FROM collection_stop cs
        WHERE cs.booking_id = NEW.booking_id
          AND cs.stream = s.waste_stream
          AND cs.status <> 'Cancelled'
      )
  ) THEN
    RETURN NULL;
  END IF;

  v_rollup := CASE
    WHEN v_ncn > 0 THEN 'Non-conformance'::booking_status
    WHEN v_np  > 0 THEN 'Nothing Presented'::booking_status
    ELSE 'Completed'::booking_status
  END;

  UPDATE booking
  SET status = v_rollup
  WHERE id = NEW.booking_id
    AND (
      status = 'Scheduled'
      OR (
        current_setting('verco.closeout_correction', true) = 'on'
        AND status IN ('Completed', 'Non-conformance', 'Nothing Presented')
        AND status IS DISTINCT FROM v_rollup
      )
    );

  RETURN NULL;
END;
$$;

-- ── 5. The correction RPC ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.correct_stop_outcome(
  p_stop_id          uuid,
  p_to_status        public.stop_status,
  p_reason           text,
  p_ncn_reason       public.ncn_reason DEFAULT NULL,
  p_resident_notes   text DEFAULT NULL,
  p_contractor_fault boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid              uuid := auth.uid();
  v_reason           text := btrim(coalesce(p_reason, ''));
  v_notes            text := nullif(btrim(coalesce(p_resident_notes, '')), '');
  v_booking_id       uuid;
  v_client_id        uuid;
  v_from             public.stop_status;
  v_date             date;
  v_booking_status   public.booking_status;
  v_notice_count     integer;
  v_withdrawn_id     uuid;
  v_withdrawn_status text;
  v_photos           text[] := '{}';
  v_new_notice_id    uuid;
  v_correction_id    uuid;
BEGIN
  -- NULL-safe: current_user_role() is NULL for a role-less caller.
  IF (public.current_user_role() = 'contractor-admin') IS NOT TRUE OR v_uid IS NULL THEN
    RAISE EXCEPTION 'Only a contractor admin can correct a closeout.' USING ERRCODE = '42501';
  END IF;
  IF p_to_status IS NULL
     OR p_to_status NOT IN ('Completed', 'Non-conformance', 'Nothing Presented') THEN
    RAISE EXCEPTION 'A closeout can only be corrected to Completed, Non-conformance or Nothing Presented.';
  END IF;
  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Give a reason for the correction (3 to 500 characters).';
  END IF;
  IF p_to_status = 'Non-conformance' AND p_ncn_reason IS NULL THEN
    RAISE EXCEPTION 'Choose the non-conformance reason.';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'Notes for the resident must be 2000 characters or fewer.';
  END IF;

  SELECT cs.booking_id INTO v_booking_id
  FROM collection_stop cs
  WHERE cs.id = p_stop_id;
  IF v_booking_id IS NULL THEN
    RAISE EXCEPTION 'Stop not found.';
  END IF;

  -- The rollup's per-booking advisory lock, taken BEFORE the row locks: the
  -- field closeout path takes it before its booking UPDATE, so locking the
  -- booking row first here would deadlock against a concurrent sibling-stop
  -- closeout. Re-entrant when the rollup re-takes it below.
  PERFORM pg_advisory_xact_lock(('x' || substr(v_booking_id::text, 1, 8))::bit(32)::bigint);

  SELECT cs.status, cs.client_id, cd.date
    INTO v_from, v_client_id, v_date
  FROM collection_stop cs
  JOIN collection_date cd ON cd.id = cs.collection_date_id
  WHERE cs.id = p_stop_id
  FOR UPDATE OF cs;

  -- Tenant + sub-client pin. Same message as a missing stop: never confirm
  -- that another tenant's stop exists.
  IF NOT (v_client_id IN (SELECT public.accessible_client_ids()))
     OR (public.user_sub_client_allows_booking(v_booking_id)) IS NOT TRUE THEN
    RAISE EXCEPTION 'Stop not found.';
  END IF;

  IF v_from NOT IN ('Completed', 'Non-conformance', 'Nothing Presented') THEN
    RAISE EXCEPTION 'This collection is %, not closed out, so there is nothing to correct.', v_from;
  END IF;
  IF v_from = p_to_status THEN
    RAISE EXCEPTION 'This collection is already %.', v_from;
  END IF;
  IF (now() AT TIME ZONE 'Australia/Perth')::date > v_date + 7 THEN
    RAISE EXCEPTION 'A closeout can only be corrected within 7 days of the collection date (%).',
      to_char(v_date, 'DD/MM/YYYY');
  END IF;

  SELECT b.status INTO v_booking_status
  FROM booking b
  WHERE b.id = v_booking_id
  FOR UPDATE;
  IF v_booking_status NOT IN ('Scheduled', 'Completed', 'Non-conformance', 'Nothing Presented') THEN
    RAISE EXCEPTION 'This booking is %, so its closeout can no longer be corrected.', v_booking_status;
  END IF;

  -- Withdraw the mistaken notice (only while the resident hasn't engaged).
  IF v_from = 'Non-conformance' THEN
    SELECT count(*) INTO v_notice_count
    FROM non_conformance_notice WHERE collection_stop_id = p_stop_id;
    IF v_notice_count > 1 THEN
      RAISE EXCEPTION 'This collection has more than one notice and needs a manual fix.';
    END IF;
    IF v_notice_count = 1 THEN
      SELECT n.id, n.status::text, n.photos
        INTO v_withdrawn_id, v_withdrawn_status, v_photos
      FROM non_conformance_notice n
      WHERE n.collection_stop_id = p_stop_id
      FOR UPDATE;
      IF v_withdrawn_status <> 'Issued' THEN
        RAISE EXCEPTION 'The notice is already %. Handle it from the notice instead of correcting the closeout.',
          v_withdrawn_status;
      END IF;
      DELETE FROM non_conformance_notice WHERE id = v_withdrawn_id;
    END IF;
  ELSIF v_from = 'Nothing Presented' THEN
    SELECT count(*) INTO v_notice_count
    FROM nothing_presented WHERE collection_stop_id = p_stop_id;
    IF v_notice_count > 1 THEN
      RAISE EXCEPTION 'This collection has more than one notice and needs a manual fix.';
    END IF;
    IF v_notice_count = 1 THEN
      SELECT n.id, n.status::text, n.photos
        INTO v_withdrawn_id, v_withdrawn_status, v_photos
      FROM nothing_presented n
      WHERE n.collection_stop_id = p_stop_id
      FOR UPDATE;
      IF v_withdrawn_status <> 'Issued' THEN
        RAISE EXCEPTION 'The notice is already %. Handle it from the notice instead of correcting the closeout.',
          v_withdrawn_status;
      END IF;
      DELETE FROM nothing_presented WHERE id = v_withdrawn_id;
    END IF;
  END IF;
  v_photos := coalesce(v_photos, '{}');

  -- Raise the corrected notice: Issued, reported now → a fresh 14-day window.
  IF p_to_status = 'Non-conformance' THEN
    INSERT INTO non_conformance_notice (
      booking_id, client_id, collection_stop_id, reason, notes, photos,
      reported_by, reported_at, status
    ) VALUES (
      v_booking_id, v_client_id, p_stop_id, p_ncn_reason, v_notes, v_photos,
      v_uid, now(), 'Issued'
    )
    RETURNING id INTO v_new_notice_id;
  ELSIF p_to_status = 'Nothing Presented' THEN
    INSERT INTO nothing_presented (
      booking_id, client_id, collection_stop_id, notes, photos, contractor_fault,
      reported_by, reported_at, status
    ) VALUES (
      v_booking_id, v_client_id, p_stop_id, v_notes, v_photos,
      coalesce(p_contractor_fault, false), v_uid, now(), 'Issued'
    )
    RETURNING id INTO v_new_notice_id;
  END IF;

  -- Flip the stop. The rollup trigger re-derives the booking in this same
  -- statement (AFTER ROW triggers fire before control returns here), so the
  -- flag only needs to span this one UPDATE.
  PERFORM set_config('verco.closeout_correction', 'on', true);
  UPDATE collection_stop SET status = p_to_status WHERE id = p_stop_id;
  PERFORM set_config('verco.closeout_correction', 'off', true);

  INSERT INTO stop_outcome_correction (
    collection_stop_id, booking_id, client_id, from_status, to_status, reason,
    withdrawn_notice_id, new_notice_id, corrected_by
  ) VALUES (
    p_stop_id, v_booking_id, v_client_id, v_from, p_to_status, v_reason,
    v_withdrawn_id, v_new_notice_id, v_uid
  )
  RETURNING id INTO v_correction_id;

  RETURN jsonb_build_object(
    'correction_id',       v_correction_id,
    'booking_id',          v_booking_id,
    'from_status',         v_from,
    'to_status',           p_to_status,
    'withdrawn_notice_id', v_withdrawn_id,
    'new_notice_id',       v_new_notice_id,
    'photos',              CASE WHEN v_new_notice_id IS NULL THEN '[]'::jsonb ELSE to_jsonb(v_photos) END,
    'booking_status',      (SELECT b.status FROM booking b WHERE b.id = v_booking_id)
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.correct_stop_outcome(uuid, public.stop_status, text, public.ncn_reason, text, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_stop_outcome(uuid, public.stop_status, text, public.ncn_reason, text, boolean)
  TO authenticated;
