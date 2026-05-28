# Admin Screenshot Capture Checklist

**For:** Dan, post-WMRC meeting
**Purpose:** Capture the 12 admin screenshots that the WMRC user guide Part C references.
**Tool:** macOS native — `Cmd+Shift+4` then space-bar then click the window (captures just the Chrome window, not full desktop). Or `Cmd+Shift+5` for region select.
**Save to:** `docs/screenshots/` with the exact filenames below.
**Browser sizing:** Set Chrome window to ~1440 × 900 first so screenshots match the resident-half's aspect ratio.

---

## PII redaction before save

The Verge Valet UAT tenant has real strata-contact names, real booking emails (yours plus `ai@invalesco.au`), and a real mobile number (`+61438850819`). Before saving each shot:

1. **Names** — keep "(Admin)" suffix visible (it's pedagogically useful) but blur or swap the first name to "WMRC Test" if it's a real person other than yourself.
2. **Email** — your own `daniel@dmwastemanagement.com.au` is fine to leave visible (you're the doc author); blur `ai@invalesco.au` and any other resident emails.
3. **Mobile** — blur the last 6 digits, leaving `+614X XXX XXX` visible.
4. **Strata contact names** (MUDs page) — blur unless they're synthetic test data.

Easiest tool: macOS Preview → Tools → Annotate → Rectangle (set fill to solid black/white).

---

## Sign-in once

```
URL:    https://vvtest.verco.au/auth
Login:  daniel@dmwastemanagement.com.au
OTP:    arrives in Outlook from bookings@verco.au, subject "Your VERCO OTP"
```

Stay signed in for the whole capture pass — codes expire after 10 min, no reason to re-trigger.

---

## The 12 shots

### 21-admin-dashboard.png
```
URL:     https://vvtest.verco.au/admin
Capture: Full viewport — sidebar visible, 4 stat cards, "Upcoming Collection Dates" + "This Week's Summary" panels.
Notes:   The tenant selector pill ("Verge Valet") top-centre is a contractor-admin artefact. Mention in caption but don't crop it.
Redact:  Nothing on this page.
```

### 22-admin-bookings-list.png
```
URL:     https://vvtest.verco.au/admin/bookings
Capture: Full table — REF / ADDRESS / TYPE / SERVICES / COLLECTION DATE / AREA / STATUS / CREATED columns. Filter strip ("All Statuses / All Areas / All Types") visible at top.
Notes:   Multi-area mix (FRE, MOS, KWN, CAM, COT) is the WMRC story — keep that variety in frame.
Redact:  Address column is fine (street + suburb only, no resident name).
```

### 23-admin-bookings-filter-applied.png
```
URL:     https://vvtest.verco.au/admin/bookings (then click "All Statuses" → "Confirmed")
Capture: Same view but with the filter pill highlighted + "Showing X of Y" reflecting the narrowed set.
Redact:  As above.
```

### 24-admin-booking-detail-confirmed.png
```
URL:     https://vvtest.verco.au/admin/bookings (then click row COT-E88PNN or any other Confirmed row)
Capture: Right-side slideover open — green "Confirmed" badge, COLLECTION DETAILS / CONTACT / SERVICES panels visible.
Redact:  Contact name + email + mobile in the CONTACT panel.
```

### 25-admin-booking-detail-pending-payment.png
```
URL:     https://vvtest.verco.au/admin/bookings (then click row FRE-S-FR1QZE or any "Pending Payment" row)
Capture: Right-side slideover, scrolled down to show both the "Pay Now" (green outline) and "Cancel Booking" (red outline) action buttons at the bottom. ACTIVITY timeline visible above the buttons.
Redact:  Contact name + email + mobile.
```

### 26-admin-cancel-dialog.png
```
URL:     Continue from #25 (or any cancellable booking detail)
Action:  Click "Cancel Booking" — the confirmation modal appears. DO NOT confirm — just screenshot then close.
Capture: The modal in foreground over the dimmed slideover.
Redact:  Nothing inside the modal (it's status text only). Background slideover may need redaction — easier to just crop tight on the modal.
```

### 27-admin-ncn-list.png
```
URL:     https://vvtest.verco.au/admin/non-conformance
Capture: Currently shows the empty state ("No non-conformance notices found"). That's fine for v1.2 — the empty-state itself is documentation. If you trigger a test NCN via field flow before capturing, even better.
Redact:  Nothing (empty state).
```

### 28-admin-np-list.png
```
URL:     https://vvtest.verco.au/admin/nothing-presented
Capture: Same shape as #27 — table + filters, likely empty state.
Redact:  Nothing.
```

### 29-admin-refunds-list.png
```
URL:     https://vvtest.verco.au/admin/refunds
Capture: Table columns: BOOKING / RESIDENT / AMOUNT / REASON / STATUS / STRIPE REF / REQUESTED / REVIEWED BY. Empty state expected.
Redact:  Nothing.
```

### 30-admin-muds-list.png
```
URL:     https://vvtest.verco.au/admin/muds
Capture: Full viewport showing the 4 status cards (Contact Made 364 / Registered 1 / Inactive 0 / Not Set 0) + the table with at least 3 rows visible. Cadence column showing both "Quarterly" and "Ad-hoc" is a useful teaching moment.
Redact:  Strata contact names in the STRATA CONTACT column.
```

### 31-admin-properties-list.png
```
URL:     https://vvtest.verco.au/admin/properties
Capture: Header showing "Eligible Properties · 89,390 properties", green "Import Properties" button, "Geocode All (0 pending)" button, table with at least 5 rows.
Notes:   The "Import Properties" + "Geocode All" buttons are contractor-admin only. Mention in caption.
Redact:  Nothing (addresses without resident names are fine).
```

### 32-admin-service-tickets.png
```
URL:     https://vvtest.verco.au/admin/service-tickets
Capture: Table with the 2 existing tickets visible (TKT-DOF0KT + TKT-N8TBHH).
Redact:  Resident column — "Daniel Taylor (Admin)" can stay; "ai -" needs to be replaced or blurred.
```

---

## Optional (nice-to-have, not blocking)

- **33-admin-new-booking-form.png** — `/admin/bookings` → click `+ New Booking` → admin-on-behalf wizard step 1.
- **34-admin-mud-detail.png** — `/admin/muds` → click any MUD row → MUD detail page including unit count and strata contact panel.
- **35-admin-property-detail.png** — `/admin/properties` → click any row → property detail (where MUD conversion happens).

---

## After capturing

1. All 12 (+ optional) PNGs in `docs/screenshots/`.
2. Run the doc rebuild — same pandoc/wkhtmltopdf pipeline that produced v1.1's HTML+PDF.
3. Commit + open PR to `develop` with title "docs(wmrc): add admin operational guide (Part C)".
