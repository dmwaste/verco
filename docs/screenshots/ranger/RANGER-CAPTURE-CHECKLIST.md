# Ranger guide — screenshot capture checklist

Recipe for capturing the 10 screenshots referenced in `docs/wmrc-ranger-guide.md`
(placeholders `R01`–`R10`, embedded as HTML comments so the guide renders cleanly
without them). Run this pass once a **ranger** test identity with assigned areas
exists on a reachable field host.

## Prerequisites (the bit that needs D&M, not the doc)

The ranger flow can only be shot with real seeded data:

1. **A ranger login** on `field.verco.au` (or a UAT field host) — a `user_roles`
   row with `role='ranger'`, `is_active=true`, `client_id` = Verge Valet, and at
   least one **assigned collection area** (set `sub_client_id` too if shooting the
   member-council-narrowed view, e.g. City of Cockburn).
2. **Eligible properties** in that ranger's area(s) so Lookup returns results.
3. **Bookings in three place-out states** at those properties so all three verdict
   banners can be shot:
   - green (**open**): an upcoming booking with the 72 h place-out window already open;
   - amber (**not-yet**): an upcoming booking whose window has **not** opened;
   - red (**none**): a property with no upcoming booking.
4. **OTP access** to the ranger login's inbox to complete sign-in.

Until (1)–(3) are seeded, the guide ships text-complete with placeholders — the
same way the WMRC admin half (`21`–`32`) shipped before its capture pass.

## Capture settings

- **Mobile viewport** — the field app is a phone PWA. Use Playwright
  `browser_resize` to **390×844** (iPhone 12/13/14 logical size) so the layout
  matches what rangers actually see, not the tablet/desktop `max-w-xl` fallback.
- **Full-page** screenshots (`fullPage:true`) for the scrolling forms (R06–R09).
- Save 1× (or 2× for retina crispness) into **`docs/screenshots/ranger/`** —
  do NOT overwrite the WMRC-shared `docs/screenshots/*.png` or the Kwinana
  `docs/screenshots/kwn/*.png`.
- OTP inputs are **controlled React inputs** — synthetic key events don't register.
  Use `browser_type`/`pressSequentially`, or the native-setter `browser_evaluate`
  trick, per the `chrome-mcp-screenshot-trap.md` / WMRC pipeline notes.

## Shot list

| # | File | Screen | How to reach it |
|---|---|---|---|
| R01 | `R01-signin.png` | Sign in (email entry) | Open `field.verco.au` signed out |
| R02 | `R02-verify.png` | 6-digit code entry | Submit the email → verify screen |
| R03 | `R03-frame.png` | Top bar + bottom tabs | Any ranger screen; frame the navy header (VERCO mark, Ranger pill, date, area-code pill) + the Lookup/New ID/My IDs tab bar |
| R04 | `R04-lookup.png` | Address Lookup with results | Lookup tab → type a street in the ranger's area (3+ chars) |
| R05 | `R05-verdict-green.png` | Property detail — green verdict | Open a property with an open-window upcoming booking. **Optionally also shoot** `R05b-verdict-amber.png` (too-early) and `R05c-verdict-red.png` (no booking) for a fuller set |
| R06 | `R06-id-gps.png` | New ID — location/GPS | New ID tab → GPS locked state with map pin + coords |
| R07 | `R07-id-photos.png` | New ID — photo grid | Scroll to Photos; show the "Add photo" tile (add one dummy photo for the filled state) |
| R08 | `R08-id-date.png` | New ID — collection date grid | Scroll to Collection Date; show the date tiles with "N ID spots" |
| R09 | `R09-id-confirm.png` | ID Collection Logged | Submit a test ID → confirmation summary card |
| R10 | `R10-my-ids.png` | My IDs list | My IDs tab with at least one raised ID (ideally a few at different statuses) |

## After capture

1. Drop the PNGs into `docs/screenshots/ranger/`.
2. In `docs/wmrc-ranger-guide.md`, replace each `<!-- SCREENSHOT: RNN-… -->`
   comment with `![caption](screenshots/ranger/RNN-slug.png)`.
3. Rebuild the PDF (see the "Rebuild" recipe in
   memory `wmrc-user-guide-build-pipeline.md` — same pandoc→Chrome commands,
   swap the filename stem to `wmrc-ranger-guide`).
4. Bump the guide to v1.1 and note the capture in the revision log.
