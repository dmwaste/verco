# Kwinana ranger guide — screenshot capture checklist

Recipe for capturing the Kwinana-specific screenshots referenced in
`docs/kwn-ranger-guide.md` (placeholders `K03`–`K10`, embedded as HTML comments so
the guide renders cleanly without them). The two sign-in shots (`R01`, `R02`) are
shared with the Verge Valet guide — the sign-in screens carry no tenant data.

Do NOT reuse the Verge Valet `R03`–`R10` shots here: they show Mosman Park /
Cottesloe addresses, `MOS-…` / `PEP-…` references, and a header pill listing all
twelve Verge Valet area codes (plus the pre-#306 KWN leak). A Kwinana ranger
would be trained on the wrong patch.

## Prerequisites (the bit that needs D&M, not the doc)

1. **A ranger login** on `field.verco.au` — a `user_roles` row with
   `role='ranger'`, `is_active=true`, `client_id` = City of Kwinana,
   `sub_client_id` NULL (Kwinana has no sub-clients; the header pill shows
   `KWN-1 · KWN-2 · KWN-3 · KWN-4`).
2. **Bookings in three place-out states** at Kwinana properties so all three
   verdict banners can be shot — Kwinana's window is **48 h**
   (`client.place_out_hours_before` WHERE slug='kwn'):
   - green (**open**): an upcoming booking whose 48 h window has opened;
   - amber (**not-yet**): an upcoming booking whose window has **not** opened;
   - red (**none**): an eligible property with no upcoming booking.
3. **OTP access** to the ranger login's inbox to complete sign-in.

Until (1)–(2) exist, the guide ships text-complete with placeholders — exactly
how the Verge Valet ranger guide v1.0 shipped before its capture pass.

## Capture settings

- **Mobile viewport 390×844** (Playwright `browser_resize`) so the layout matches
  a phone, not the tablet/desktop `max-w-xl` fallback.
- **Full-page** for the scrolling ID form (K06) and confirmation (K09).
- Save into **`docs/screenshots/kwn-ranger/`** — never overwrite
  `docs/screenshots/ranger/*.png` (Verge Valet) or the resident/admin sets.
- OTP inputs are controlled React inputs — use `pressSequentially` / the
  native-setter trick (memory `chrome-mcp-screenshot-trap.md`).
- **Only ONE Verco database.** Submitting an ID on `field.verco.au` dispatches a
  real crew. Capture K09 via a controlled test ID and cancel it immediately
  (`UPDATE booking SET status='Cancelled'`), then verify 0 stops were created —
  same procedure as the Verge Valet `PEP-AHMUY5` capture.

## Shot list

| # | File | Screen | How to reach it |
|---|---|---|---|
| K03 | `K03-frame.png` | Top bar + bottom tabs | Any ranger screen; frame the navy header with the `KWN-1…KWN-4` pill + Lookup/New ID/My IDs tabs |
| K04 | `K04-lookup.png` | Address Lookup with results | Lookup → type a Kwinana street (3+ chars) |
| K05 | `K05-verdict-green.png` | Property detail — green verdict | Open a property with an open-window booking. Also `K05-verdict-amber.png` and `K05-verdict-red.png` |
| K06 | `K06-id-form-top.png` / `K06-id-form-bottom.png` | New ID form | From a lookup (pin pre-filled); scroll for photos + date grid |
| K09 | `K09-id-confirm.png` | ID Collection Logged | Submit the controlled test ID → confirmation card (`KWN-…` ref); cancel straight after |
| K10 | `K10-my-ids.png` | My IDs list | My IDs tab with the test ID visible (before/after cancelling — a Cancelled badge is fine) |

## After capture

1. Drop the PNGs into `docs/screenshots/kwn-ranger/`.
2. In `docs/kwn-ranger-guide.md`, replace each `<!-- SCREENSHOT: KNN-… -->`
   comment with `![caption](screenshots/kwn-ranger/KNN-slug.png)`.
3. Rebuild the PDF (pandoc → headless Chrome, memory
   `wmrc-user-guide-build-pipeline.md`, stem `kwn-ranger-guide`).
4. Bump the guide to v1.1 and note the capture in the revision log.
