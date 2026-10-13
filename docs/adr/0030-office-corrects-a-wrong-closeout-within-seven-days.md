# 0030 — The office can correct a crew's wrong closeout within 7 days; the crew's buttons stay one-tap

- **Date:** 13/10/2026
- **Status:** Accepted

## Decision

A contractor admin can change a collection's closeout outcome (Completed, Non-conformance, Nothing Presented) from the admin booking page, up to 7 days after the collection date, with a written reason. Crews still cannot change a closeout once they've tapped it, and the crew's "Mark as Completed" button gets no "are you sure?" prompt.

When the outcome changes, the resident gets the message that matches the corrected outcome:

- **Changed to Non-conformance or Nothing Presented:** the normal notice email, with a fresh 14-day dispute window.
- **Changed to Completed:** a short "please disregard our earlier notice" email, and the mistaken notice is withdrawn.

A notice can only be withdrawn while it's still untouched (status Issued). Once the resident has disputed it, or the office has started reviewing it, it goes through the normal investigation instead. A booking that has already been rebooked can't be corrected.

## Why

Crews occasionally tap Completed when the job was really a non-conformance (or the reverse). Before this, nobody could fix it in the app. The resident either never got the NCN notice and lost their dispute window, or got an NCN email they hadn't earned. The only fix was a developer hand-editing the live database.

**Who can correct, and when.** The correction is limited to contractor admins, inside 7 days, with every change logged (who, when, from, to, and why). That's because a closeout outcome feeds council reporting: being able to quietly turn a non-conformance into a success would undermine those figures. The collection date on the crew's record is still never changed (ADR 0009), so a correction can't make a late collection look on time.

**Why no confirm prompt for crews.** Crews close hundreds of stops a day, and Completed is the right answer for almost all of them. A prompt on every tap trains people to tap straight through it, so it wouldn't catch the mistake. It would only slow down the 99% case. NCN and Nothing Presented already open a form, so those can't be tapped by accident. Fixing the rare mistake afterwards in the office is cheaper and more reliable.

## What this changed from the original plan

"Terminal stop statuses are immutable" (stop schema, 10/06/2026) and "Completed is a final booking status" were absolute rules. They now have exactly one exception: the `correct_stop_outcome` database function, which only a contractor admin can call. Everything else, including crews, background jobs and the service role, is still blocked.
