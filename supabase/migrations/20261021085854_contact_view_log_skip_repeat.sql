-- contact_view_log: a re-render is not a new view (VER-322, ADR 0040).
--
-- The caller lookup logs every contact it shows each time the page renders on
-- the server. Some renders aren't a fresh look at the record: the top-bar
-- council switcher refreshes the page, and the cross-council "Add a note"
-- switch re-renders it in its action response. Each of those wrote a second
-- set of rows, so the log overstated how often a resident's record was opened.
--
-- A BEFORE INSERT trigger now skips the row (RETURN NULL) when the same staff
-- member already logged the same contact on the same screen within the last
-- five minutes, about the length of a call. A later look is a new view.
--
-- SECURITY DEFINER so the check sees the caller's own earlier rows: staff roles
-- can insert but not read the log. It only ever skips a genuine row, one for
-- the caller (viewed_by = auth.uid()) stamped now (viewed_at = now()). A row
-- naming anyone else or a backdated one goes through untouched and RLS refuses
-- it, so the skip can't reveal whether someone else has viewed a contact, nor
-- turn a refusal into a silent success. Indexed by idx_contact_view_log_contact.
--
-- Idempotent: CREATE OR REPLACE, DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION public.contact_view_log_skip_repeat()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.viewed_by = auth.uid() AND NEW.viewed_at = now() AND EXISTS (
    SELECT 1 FROM contact_view_log l
     WHERE l.contact_id = NEW.contact_id
       AND l.viewed_by = NEW.viewed_by
       AND l.surface = NEW.surface
       AND l.viewed_at > now() - interval '5 minutes'
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.contact_view_log_skip_repeat() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contact_view_log_skip_repeat ON public.contact_view_log;
CREATE TRIGGER contact_view_log_skip_repeat
  BEFORE INSERT ON public.contact_view_log
  FOR EACH ROW EXECUTE FUNCTION public.contact_view_log_skip_repeat();
