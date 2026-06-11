#!/usr/bin/env node
/**
 * load-faqs.mjs — seed tenant FAQ content (markdown) into client.faq_items.
 *
 * ┌─────────────────────────── RELEASE GATE ────────────────────────────┐
 * │ The markdown below renders correctly ONLY once the FaqAnswer        │
 * │ component is live in production. Before running with --apply:       │
 * │                                                                     │
 * │   1. curl https://<tenant>.verco.au/api/health                      │
 * │   2. Confirm the SHA includes the FAQ-markdown release              │
 * │      (git branch -r --contains <sha> must include origin/main)      │
 * │                                                                     │
 * │ Running early ships raw pipe characters to residents — worse than   │
 * │ the flat text it replaces. (Ghost-release lesson: git history ≠     │
 * │ deploy state.)                                                      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Source of truth: this file seeds content; once loaded, PROD IS THE
 * SOURCE OF TRUTH — client-admins edit via /admin/clients → FAQs tab.
 * Re-running --apply OVERWRITES any admin edits made since (a timestamped
 * snapshot of the current rows is written to scripts/.faq-snapshots/
 * first, so recovery is one file away).
 *
 * Usage:
 *   SUPABASE_SERVICE_ROLE_KEY=... node scripts/load-faqs.mjs           # dry run
 *   SUPABASE_SERVICE_ROLE_KEY=... node scripts/load-faqs.mjs --apply   # write
 *
 * Key: `supabase projects api-keys --project-ref tfddjmplcizfirxqhotv`
 * (service role — anon cannot UPDATE client rows under RLS).
 *
 * Content provenance: scraped 11/06/2026 from
 *   https://www.vergevalet.com.au/faqs/ (14 items)
 *   https://www.kwinana.wa.gov.au/.../pre-booked-verge-collections (8 items)
 * Wording kept verbatim; structure restored as markdown. In-product action
 * links rewritten portal-relative (/book, /dashboard); external references
 * keep their original absolute URLs.
 */

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUPABASE_URL = 'https://tfddjmplcizfirxqhotv.supabase.co'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const APPLY = process.argv.includes('--apply')

if (!SERVICE_ROLE_KEY) {
  console.error('ERROR: set SUPABASE_SERVICE_ROLE_KEY (see header comment)')
  process.exit(1)
}

const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
})

// ── Verge Valet (slug: vergevalet) — 14 items ──────────────────────────

const VV_FAQS = [
  {
    question: 'What is Verge Valet™?',
    answer: `Verge Valet™ provides you with access to bulk and/or greenwaste collections at a time convenient to you. It is available all year round; replacing the set-date bulk and/or greenwaste collections that were previously offered by your council.

Verge Valet™ is available in the following council areas:

- Town of Cambridge
- Town of Cottesloe
- City of Fremantle (bulk waste only)
- Town of Mosman Park
- Shire of Peppermint Grove
- City of Vincent
- City of Subiaco (greenwaste only)
- City of South Perth
- Town of Victoria Park`,
  },
  {
    question: 'How do I book a Verge Valet™ collection?',
    answer: `Bookings can be made [here](/book).

If you are unable to book online, you can book over the phone. Call the WMRC Recycling Hotline on [9384 6711](tel:0893846711).`,
  },
  {
    question: 'What is accepted for a Verge Valet™ bulk waste collection?',
    answer: `Verge Valet™ accepts most items for collection. Items that cannot be collected will be left behind if put out for collection, and a non-conformance notice will be issued — this is for the safety of our team.

Each collection must be no more than 3m³ (3m x 1m x 1m). Items must be less than 1.5m in length to be easily picked up and put into the collection truck. We understand this may not be possible for bulky furniture items.

**Bulk waste collections are not available in the City of Subiaco.**

| Accepted items | Items NOT accepted |
|---|---|
| Air conditioners | NO asbestos products |
| BBQs (not gas bottles) | NO batteries |
| Bicycles | NO beanbags |
| Bulk polystyrene | NO building materials (brick, rubble, concrete, tiles, pavers, sand etc.) |
| Bulky toys | NO car oil & fuel |
| E-waste (TVs, computers, accessories) | NO two stroke & petrol lawnmowers |
| Fencing (timber & steel only) | NO food |
| Floor coverings (linoleum, carpet) | NO medical waste or personal hygiene products |
| Fridges/freezers (doors removed or taped shut) | NO glass panels (eg. tabletops, mirrors & window panes) |
| Garden hoses | NO hazardous materials (flammable, toxic or corrosive liquids) |
| Household furniture (no glass) | NO paint |
| Mattresses (not accepted in Town of Cambridge or Town of Victoria Park*) | NO dirt, soil, sand & mulch |
| Mattress bases | NO tyres |
| Plant pots | NO vehicles, car bodies, car parts |
| Scrap metal | |
| Small electrical goods | |
| Timber (not garden waste; max. 1.5m length) | |
| White goods (doors removed) | |
| Wire/strapping | |

**Please note:** Many bulk waste items that are not accepted in a Verge Valet™ collection may be taken to a local recycling centre:

- [The West Metro Recycling Centre](https://www.wmrc.wa.gov.au/recycling-disposal/west-metro-recycling-centre/accepted-items-free-for-a-fee/) — 60 Lemnos St, Shenton Park (open to residents of any council area)
- [Fremantle Recycling Centre](https://www.fremantle.wa.gov.au/waste-and-environment/fremantle-recycling-centre/) — 19A Montreal St, Fremantle (**City of Fremantle residents only**)
- South Perth Recycling Centre — 199 Thelma St, Como (**City of South Perth residents only**)

*Mattress collection in the Town of Cambridge and Town of Victoria Park can be organised directly through the council — see [Town of Cambridge mattress collection](https://www.cambridge.wa.gov.au/Residents/Waste-Recycling/Mattress-Collection-Verge-Valet%E2%84%A2-Tip-Passes) or [Town of Victoria Park mattress collection](https://www.victoriapark.wa.gov.au/residents/waste-and-recycling/mattress-collections-on-demand.aspx).`,
  },
  {
    question: 'What is accepted for a Verge Valet™ greenwaste collection?',
    answer: `**Not available in City of Fremantle.** 3m³ per collection booked.

| Accepted items | Items NOT accepted |
|---|---|
| Branches | NO items longer than 1.5m or branches over 300mm diameter |
| Flowers | NO asbestos products |
| Leaves, weeds & grass clippings | NO building materials |
| Palm fronds | NO chemically treated or painted/stained timber |
| Twigs | NO dirt, soil, sand & mulch |
| | NO fencing materials* |
| | NO household rubbish |
| | NO plant pots/garden hoses* |
| | NO plastic bags containing greenwaste |
| | NO rocks, bricks & rubble |
| | NO turf |

*These items can be collected as part of a bulk collection.

If you are worried about small, loose items blowing around, please place them under your branches or twigs. You may also place loose items in an open cardboard box (which may be returned to your property after collection), or under a weighted tarpaulin.`,
  },
  {
    question: 'How far in advance do I need to book?',
    answer: `You can book up to 8 weeks in advance. We recommend booking as early as possible (at least 2 weeks in advance) as collection dates can fill up. Dates that are no longer available will be removed from the website.

The summer holidays (Dec-Jan) and the end of the financial year (June) are our busiest times. If you would like a collection during these periods we recommend booking well in advance.

*Please note that Verge Valet™ collections are not available on public holidays.*`,
  },
  {
    question: 'How can I change or cancel my booking?',
    answer: `We get it, life happens.

You can change, cancel, or postpone your booking by 3:30pm on the business day before your collection date if you have set up an account on the booking system. [Make a change or cancellation online here](/dashboard).

If you have not set up an account, you can phone us on [9384 6711](tel:0893846711) during business hours.

**Please let us know by 3:30pm on the business day before your collection, or you will lose your collection allocation.**`,
  },
  {
    question: 'How many collections can I book using Verge Valet™?',
    answer: `Check the table to see how many collections you are entitled to each financial year. Collections reset on 1 July.

| Council | Bulk waste collections | Green waste collections |
|---|---|---|
| Town of Cambridge | 2 | 1 |
| Town of Cottesloe | 2 | 1 |
| City of Fremantle | 1 | N/A |
| Town of Mosman Park | 2 | 1 |
| Shire of Peppermint Grove | 3 | 3 |
| City of South Perth | 1 | 2 |
| City of Subiaco | N/A | 3 |
| Town of Victoria Park | 2 | 1 |
| City of Vincent | 2 collections total | |

You may swap your bulk waste collection for a green waste collection if you prefer (excluding Fremantle, Subiaco and Vincent).

City of Vincent properties can have two bulk waste collections or one bulk and one green waste collection. City of Vincent properties cannot have two green waste collections.

You may choose to purchase additional collections through **Verge Valet Extra**. This is a pre-paid collection service that follows the same terms, conditions and guidelines as Verge Valet™. To book, follow the regular booking process and select the 'Verge Valet Extra' checkbox. You will receive an invoice by email.`,
  },
  {
    question: 'Can I book more than one collection at a time?',
    answer: `Yes, if you have the allocations available you may book multiple collections. [Check your available allocations by searching your address here](/book).

**Place your bulk waste and green waste out for collection in two separate piles, even if they are scheduled for collection on the same day. Mixed piles will not be collected.**`,
  },
  {
    question: "I don't want to use my verge. Where else can I place my items for collection?",
    answer: `If you don't want items sitting on your verge, or there is no space due to vegetation, you can place your items at the end of your driveway, close to the street. Please note that our collection team are unable to enter your property. They will not come past your letterbox.

If you don't have a verge or a driveway, please contact our team on [9384 6711](tel:0893846711) and we will discuss a suitable place for your waste items.`,
  },
  {
    question: 'I live on a road with busy street parking/other obstructions. How can I make sure my waste is accessible?',
    answer: `The Verge Valet™ team use bobcats to collect your waste, so they'll need to be able to access the verge. If waste items are blocked by cars on the street the team may not be able to complete the collection.

Place your waste somewhere accessible, with room to manoeuvre from the road and the driveway.

If you live in the Town of Cottesloe, City of Vincent or Town of Victoria Park, your council may be able to assist by placing out traffic cones to prevent cars parking in the way. Contact [vergevalet@wmrc.wa.gov.au](mailto:vergevalet@wmrc.wa.gov.au) or call [9384 6711](tel:0893846711) to enquire. Please try to give at least one week's notice before your scheduled collection date.`,
  },
  {
    question: 'How can I stop people dumping their items on my pile or making a mess of it?',
    answer: `If you're concerned about people adding to your Verge Valet™ collection, we recommend placing your waste items out as close as possible to the collection date. Placing the waste out the day or evening before will help minimise the risk of any illegal dumping.

If someone does dump their items on your pile, please let us know as soon as possible before your collection so we can investigate.

It can be helpful to take a photo of your waste after you've placed it on the verge so we have evidence of what is yours and what has been dumped by others.`,
  },
  {
    question: 'What happens to my items collected through Verge Valet™? Do they just go to landfill?',
    answer: `No! We work with local businesses to recover and recycle as much of your bulk waste as possible.

- **Whitegoods and metal appliances** go to a scrap metal recycler to be separated, processed, and sold to manufacturers to make new products.
- **Mattresses** are separated into parts to be recycled. Steel springs become metal products, foam becomes carpet underlay, and wooden frames can be turned into furniture or chipwood.
- **E-waste** is shredded and the components are separated out for reuse. 90% of e-waste consists of materials that can be used again, like copper, aluminium and steel.
- **Cardboard, timber, and any remaining metal** is also sorted and separated for recycling downstream.

By separating any metals, whitegoods, mattresses and e-waste from your furniture or general junk, you can help us recover and recycle as much as possible. On average, we are able to recover 85% of the bulk waste materials collected through Verge Valet™.

Before booking Verge Valet™, we encourage you to look for other ways to reuse items that are in good condition — your local Facebook Buy Nothing group, online selling sites like Gumtree and Facebook Marketplace, or charity donation/collection.`,
  },
  {
    question: 'Who can I contact about Verge Valet™?',
    answer: `Your council can answer basic questions about the service and view any existing bookings:

| Council | Phone | Hours |
|---|---|---|
| Town of Mosman Park | [9383 6600](tel:0893836600) | 8:30am – 4:30pm Mon-Fri |
| Town of Cottesloe | [9285 5000](tel:0892855000) | 8:30am – 4:30pm Mon-Fri |
| Town of Cambridge | [9347 6000](tel:0893476000) | 8:00am – 5:00pm Mon-Fri |
| Shire of Peppermint Grove | [9286 8600](tel:0892868600) | 8:30am – 5:00pm Mon-Fri |
| City of Vincent | [9273 6000](tel:0892736000) | 8:30am – 5:00pm Mon-Fri |
| City of Fremantle | 1300 MY FREO | 8:00am – 5:00pm Mon-Fri |
| City of South Perth | [9474 0777](tel:0894740777) | 8:30am – 4:30pm Mon-Fri |
| City of Subiaco | [9237 9222](tel:0892379222) | 9:00am – 4:30pm Mon-Fri |
| Town of Victoria Park | [9311 8111](tel:0893118111) | 8:30am – 5:00pm Mon-Fri |

For more complex questions, please call the **WMRC Recycling Hotline** on [9384 6711](tel:0893846711) (8:30am – 4:30pm Mon-Fri).`,
  },
  {
    question: 'My question is not listed here',
    answer: `If you have a general question about Verge Valet™, contact the WMRC on [9384 6711](tel:0893846711) or use the contact form below.

You can check how many allocations your property has left by [searching your address here](/book).

Bookings can be changed or cancelled [online](/dashboard) only if you have made an account on the booking portal. Otherwise, please contact us using the channels above.`,
  },
]

// ── City of Kwinana (slug: kwn) — 8 items ───────────────────────────────

const KWN_FAQS = [
  {
    question: 'Can I book more than one collection at a time?',
    answer:
      'Yes, you can book multiple collections on the same date if you have more than one allocation remaining. Just [select your address in the online booking portal](/book) and choose all the collections you need.',
  },
  {
    question: 'Can I order additional services beyond my standard allocation?',
    answer: `Yes, you can order additional services. You will be required to pay for any services over your annual allocation at a discounted rate. In 2025/26, these rates are:

| Item | Quantity per collection | User-pays fee 2025/26 |
|---|---|---|
| Bulk Waste | 3m³ | $135.08 |
| Green Waste | 3m³ | $89.67 |
| E-Waste | 6 items up to 1m³ | $45.61 |
| Whitegoods | 1 item | $38.36 |
| Mattress | 1 item | $77.47 |`,
  },
  {
    question: "Will the pre-booked service limit residents' ability to collect free items from each other?",
    answer: `No. The pre-booked verge collection service is intended for items that are no longer usable and at the end of their life.

If your items are still in good condition, consider selling or giving them away through [Gumtree](https://www.gumtree.com.au/) or [Facebook Marketplace](https://www.facebook.com/marketplace/). You can also share your item to a local Buy Nothing group or donate to a charity to keep a usable item in circulation.`,
  },
  {
    question: 'Do all properties receive this service?',
    answer: `All residential properties receive the pre-booked service.

Those living in unit complexes with more than 5 units will receive quarterly collections that must be pre-booked by the Strata Manager. Please contact your Strata Manager for more information regarding collections from your complex.

Commercial properties are not eligible for this service.`,
  },
  {
    question: "Why don't we have tip passes?",
    answer: `Tip passes can be limiting as many residents don't have access to a suitable vehicle or trailer to transport large or heavy waste items, making disposal difficult and inconvenient.

Instead, the City of Kwinana offers a pre-booked verge collection and user-pays system, which is a more accessible, time-efficient, and cost-effective solution for most households. This service allows you to book a collection at a time that suits you, and we'll collect the items directly from your verge.

It also helps improve waste separation, making recycling more effective and reducing landfill.`,
  },
  {
    question: 'Why did you change to a pre-booked system?',
    answer: `As part of a review of the verge collection service, the City of Kwinana explored several collection models to find the most effective option for our community. The decision was guided by a multiple criteria analysis which evaluated the services based on four key areas: environmental, social, economic, and governance outcomes.

The pre-booked system was identified as the best fit for Kwinana, offering greater flexibility for residents, improved recycling outcomes, and better value for the community.

For full details on the options considered, associated costs, and outcomes, please refer to the Verge Collection Service Review Report 2024 on the City of Kwinana website.`,
  },
  {
    question: 'What local buy and sell groups are available?',
    answer: `Local Buy & Sell Facebook groups include:

- Buy Nothing Bertram/Calista/Casuarina/Medina/Orelia/Parmelia, WA
- Kwinana Calista Medina Leda Orelia Parmelia Bertram Wellard Marketplace
- All Things Free Rockingham & Surrounding Areas
- Kwinana, Wellard and surrounding Suburbs Buy and Sell
- Bertram Buy And Sell
- Kwinana & Surrounds Marketplace

Search the group name on Facebook to find and join.`,
  },
  {
    question: 'What happens to my e-waste?',
    answer: `E-waste is rapidly becoming one of WA's biggest waste challenges, and since the introduction of the e-waste to landfill ban in 2024, the City is committed to providing options to recycle e-waste correctly — this is where the pre-booked verge collections come in to play.

All e-waste collected in the City's pre-booked verge collection system is recycled by a certified e-waste recycler. Items are carefully dismantled and sorted into different material streams — like metals, plastics, and circuit boards. These materials are then recycled and reused to make new products, helping reduce waste and save natural resources.`,
  },
]

// ── Load ────────────────────────────────────────────────────────────────

const TENANTS = [
  { slug: 'vergevalet', label: 'Verge Valet', faqs: VV_FAQS },
  { slug: 'kwn', label: 'City of Kwinana', faqs: KWN_FAQS },
]

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

// Validate content before touching anything
for (const tenant of TENANTS) {
  const parsed = z.array(faqItemSchema).safeParse(tenant.faqs)
  if (!parsed.success) {
    console.error(`Content validation failed for ${tenant.label}:`, parsed.error.issues[0])
    process.exit(1)
  }
}

// Snapshot current prod rows (recovery path if --apply clobbers admin edits)
const { data: current, error: snapErr } = await supabase
  .from('client')
  .select('id, slug, faq_items')
  .in('slug', TENANTS.map((t) => t.slug))

if (snapErr) {
  console.error('Snapshot query failed:', snapErr.message)
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const snapshotDir = join(__dirname, '.faq-snapshots')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(snapshotDir, { recursive: true })
const snapshotPath = join(snapshotDir, `faq-items-${stamp}.json`)
writeFileSync(snapshotPath, JSON.stringify(current, null, 2))
console.log(`Snapshot of current prod faq_items → ${snapshotPath}`)

for (const tenant of TENANTS) {
  const row = current?.find((c) => c.slug === tenant.slug)
  if (!row) {
    console.error(`⚠️  Tenant not found: ${tenant.label} (slug ${tenant.slug}) — skipped`)
    continue
  }
  console.log(`${tenant.label}: ${row.faq_items?.length ?? 0} current → ${tenant.faqs.length} new items`)

  if (!APPLY) continue

  const { error } = await supabase
    .from('client')
    .update({ faq_items: tenant.faqs })
    .eq('id', row.id)

  if (error) {
    console.error(`❌ ${tenant.label}: ${error.message}`)
    process.exitCode = 1
  } else {
    console.log(`✅ ${tenant.label} updated`)
  }
}

if (!APPLY) {
  console.log('\nDry run complete — re-run with --apply to write (read the RELEASE GATE header first).')
}
