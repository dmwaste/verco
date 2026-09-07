# 0020 — Pooled councils accept MUD bookings on any open collection date

- **Date:** 01/09/2026
- **Status:** Accepted

## Decision

For councils that share one pooled crew capacity across their areas (Verge Valet), a MUD (apartment/strata block) can be booked onto **any open collection date** — the same dates ordinary residents book. Councils where crews run **dedicated MUD days** (Kwinana) are unchanged: their MUDs can still only be booked onto dates staff have marked as MUD dates.

## Why

On 28 August staff tried to book a registered 38-unit block in Mosman Park and the date dropdown was empty — for every Verge Valet council, forever. The "MUD date" tick was designed for the dedicated-MUD-day crew model, defaults to off on every new date, and nobody had ever ticked one for Verge Valet. But Verge Valet doesn't run dedicated MUD days — a MUD's bins go on the same truck, out of the same shared daily capacity, as everyone else's. Requiring a separate tick there wasn't protecting anything; it just made every apartment block unbookable by default, and would have kept doing so every time new dates were generated.

An interim same-day fix ticked the box on all 299 upcoming Verge Valet dates; this decision replaces that manual workaround with the rule itself, and unticks the now-meaningless boxes so the "MUD date" marker only appears where it still means something.

## What this changed from the original plan

The original MUD design assumed every council curates specific MUD dates. That stays true for dedicated-MUD-day councils; for pooled councils the curation step is removed entirely — capacity limits on the shared pool remain the only gate, which is the same protection ordinary bookings get.
