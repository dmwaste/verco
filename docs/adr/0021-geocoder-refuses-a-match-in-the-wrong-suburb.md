# 0021 — The geocoder refuses a match in the wrong suburb rather than storing it

- **Date:** 02/09/2026
- **Status:** Accepted

## Decision

When Google's best match for a council address is a **different premise** — the same street number in another suburb, an interstate namesake, or only a suburb/country with no street — Verco stores **nothing** for that property: no coordinates, no Google address, no place id. The property keeps the council's own address, shows as "not yet geocoded", and staff are told exactly what Google matched so they can disambiguate the address (usually by adding the suburb and postcode).

This extends the August subdivision guard (ADR-era fix #508), which only compared street numbers and still wrote coordinates for a "16A → 16" snap. A snap to the neighbouring lot is a few metres out; a snap to the wrong suburb is 15 km out, so the two get different treatment.

## Why

On 29 July the Vincent apartment block "12 Smith St Perth" was geocoded to 12 Smith St **Beaconsfield** — Google read "Perth" as the metro area and picked the first Smith Street it knew. The street number matched, so the guard let it through. Three things went wrong at once: the crew's route pin sat 15 km from the block, every screen showed the resident a Beaconsfield address, and the block silently took the real Beaconsfield property's Google id, which is the key the booking form matches addresses on. Staff only noticed on 2 September and fixed it by hand, by appending "6000".

It wasn't one row. A scan of production found about 170 properties in the same state: 121 in Vincent (streets in "PERTH" resolved to Darlington, Dianella, Beckenham), 36 in South Perth (a new Como estate resolved to Robina, Queensland), 11 in Cambridge resolved to the whole of Australia, and a scatter of "suburb-only" pins in Kwinana. Any booking on those rows dispatches the crew to the wrong place. A property with no pin is safer than one with a wrong pin: the route planner falls back to the written address, and the booking form still finds the row by the council's own address text.

## What this changed from the original plan

The geocoder previously trusted Google's top result whenever the street number agreed, and "geocoded" meant "Google returned something". Now a result must also be a street-level match, in WA, in a suburb that doesn't contradict the council's address. Properties that fail stay in the geocode queue and are listed as *rejected* on every surface that runs the geocoder (properties list, property edit screen, the ops CLI), instead of being counted as successes.
