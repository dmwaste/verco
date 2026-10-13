# 0031 — Property notes and permission-to-enter forms are staff-only, scoped to each council, and never deleted

- **Date:** 13/10/2026
- **Status:** Accepted

## Decision

Staff can add notes and documents to a property. The main use is a resident's signed **permission-to-enter form**, the owner's OK for crews to collect from behind a gate, down a driveway or along a private road.

- **Who sees them:** D&M office staff and that council's own staff. A council officer limited to one council (for example Cottesloe under Verge Valet) sees only that council's properties' notes. Crews, rangers and residents never see them.
- **Where:** a "Notes & documents" section on the property page, and a "form on file" banner on the admin booking page that links to it.
- **No editing, no deleting:** an entry can't be changed after it's saved. To correct one, remove it and add a new one. "Remove" hides an entry from the page but keeps it, and its file, on record with who removed it and when. Nothing is deleted from the app.
- **No expiry:** a form stays valid until staff remove it.
- **Files:** PDF or photo (JPEG, PNG, HEIC, WebP), up to 10 MB, in their own private storage. A file opens only for staff who can see its entry.

## Why

Signed forms were living in email and on paper, so nobody could find one when a council asked or a booking was disputed. They now sit with the property.

A permission-to-enter form is an indemnity that carries a resident's name and signature. That decides the rules:
- **It must never reach crews or rangers.** Red Line #2: they get no resident contact details.
- **It must never reach another council.** This follows ADR 0019 and ADR 0024.
- **It must never quietly disappear,** because it is the record we rely on if something goes wrong on private land.

The notes can't simply be added to the property record itself. Anyone can read that record, including the public booking page, because residents need it to look up their address. So notes and files sit in their own staff-only record.

## What this changed from the original plan

The existing MUD strata authorisation form keeps its own field and storage. The MUD "Registered" check depends on that field, so it was not moved into this feature. That form's storage doesn't yet check which council a file belongs to. That is a separate fix.
