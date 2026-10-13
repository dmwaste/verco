# 0028 — Verco shares tomorrow's routes with the crews at 8pm, once

- **Date:** 13/10/2026
- **Status:** Accepted

## Decision

Every night at **8pm**, Verco sends tomorrow's routes to the crews' phones itself, from whatever is planned in OptimoRoute at that moment. Ops no longer press or schedule "Share routes" in OptimoRoute.

It happens **once**. If anything changes after 8pm, staff re-share that route by hand in OptimoRoute. Verco never re-sends on its own.

Just before sending, Verco does one last pass that removes cancelled collections from OptimoRoute. A booking moved or cancelled at 7:45pm still comes off the truck's route.

## Why

On Saturday 10 October at 6:42pm, a Mosman Park booking (MOS-12984, 29 Vlamingh Parade) was moved from Monday 12 October to 21 October. Verco did what ADR 0018 says: it cancelled Monday's job straight away and deleted it from OptimoRoute 38 minutes later. OptimoRoute's own planning screen dropped it that evening.

The crews still had it on Monday. The routes on their phones were **Friday afternoon's plan**: every arrival time in OptimoRoute's Plan History matches the plan Verco read at 4:50pm Friday, to the minute. A share sends the routes as they were when the share was set up. OptimoRoute's documentation measures changes against "the last sent or scheduled version", so a share scheduled on Friday for Sunday night carries Friday's routes. Nothing changed after Friday afternoon reached the phones: Friday night's re-plan didn't, and neither did four cancellations over the weekend across three trucks (KWN1, VV2, VV3). OptimoRoute showed this in its "3 routes have changed after they were sent" banner, but nothing prompted anyone to re-share.

ADR 0018 made Verco's changes reach OptimoRoute before the 8pm handover, but it took for granted that the handover itself happened at 8pm from the live plan. It didn't. Having Verco do the share makes that assumption true every night.

## What this changed from the original plan

The original plan left the route handover entirely to ops in the OptimoRoute web screen. Verco only sent jobs in and pulled sequences back. Now Verco also does the 8pm share, using OptimoRoute's own "send routes" feature, so residents get the same OptimoRoute notifications they got from the manual share.

ADR 0018's deadline stands: **8pm is when the crews get their routes.** It is now enforced by Verco instead of relying on ops' habits. Ops must **stop scheduling shares ahead** in OptimoRoute. An early share freezes the routes and brings this problem straight back.
