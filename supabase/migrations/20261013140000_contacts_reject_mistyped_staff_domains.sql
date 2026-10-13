-- Reject mistyped D&M staff email domains on contacts (13/10/2026).
--
-- Staff booking on residents' behalf typed their own address with the wrong
-- domain. Verco then emailed 55 Kwinana residents' booking details (Jul–Oct) to
-- dmwaste.com, verco.com.au and verco.com, none of which D&M owns
-- (dmwastemanagement.com has no mail server; those bounced). Every app write path
-- now rejects these with a suggestion (_shared/email.ts MISTYPED_STAFF_DOMAINS);
-- this CHECK is the backstop for scripts, imports and raw SQL.
--
-- Existing rows were corrected on 13/10 (D5 repair + 6 leftover contacts), so
-- the constraint validates immediately. Keep the list in step with
-- MISTYPED_STAFF_DOMAINS.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_email_not_mistyped_staff_domain CHECK (
    split_part(lower(btrim(email)), '@', 2) NOT IN (
      'dmwaste.com', 'dmwastemanagement.com', 'verco.com', 'verco.com.au'
    )
  );
