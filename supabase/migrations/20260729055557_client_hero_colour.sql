-- WMRC banner correction (29/07): the green belongs on the HERO BACKGROUND
-- only — swapping primary/accent recoloured the entire resident surface and
-- was reverted within ~20 minutes. Per-tenant hero colour, nothing else:
-- NULL keeps today's behaviour (hero gradient derives from primary_colour),
-- so every tenant is pixel-identical until its row opts in.
--
-- Consumer (landing hero in app/(public)/page.tsx) lands in the follow-up PR
-- after types regen (§18 split).

ALTER TABLE public.client
  ADD COLUMN IF NOT EXISTS hero_colour text;

COMMENT ON COLUMN public.client.hero_colour IS
  'Optional hero-background override (#rrggbb). NULL = hero derives from primary_colour. Affects ONLY the landing hero gradient.';

-- WMRC wants VV green on the hero (Jared, 29/07 — relayed by Dan).
UPDATE public.client
SET hero_colour = '#72b75c'
WHERE slug = 'vergevalet' AND hero_colour IS NULL;
