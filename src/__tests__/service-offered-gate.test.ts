import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { unofferedServiceIds } from '@/lib/booking/service-gate-server'

/**
 * A booking may only include services its collection area offers (a
 * service_rules row). Pricing reads a missing rule as 0 free units at a $0
 * extra price, so before this gate a hand-crafted create-booking request could
 * book, say, a Mattress in Town of Cambridge (which offers none) for $0.
 */

const MATTRESS = 'svc-mattress'
const BULK = 'svc-bulk'
const GREEN = 'svc-green'
const CAMBRIDGE_OFFERS = [BULK, GREEN]

describe('unofferedServiceIds — the create-booking early gate (fail closed)', () => {
  it('refuses a service the area does not offer', () => {
    expect(unofferedServiceIds([{ service_id: MATTRESS, quantity: 1 }], CAMBRIDGE_OFFERS)).toEqual([MATTRESS])
  })

  it('passes services the area offers', () => {
    expect(
      unofferedServiceIds(
        [
          { service_id: BULK, quantity: 1 },
          { service_id: GREEN, quantity: 2 },
        ],
        CAMBRIDGE_OFFERS,
      ),
    ).toEqual([])
  })

  it('fails closed when the area offers nothing (or its rules could not be read)', () => {
    expect(unofferedServiceIds([{ service_id: BULK, quantity: 1 }], [])).toEqual([BULK])
  })

  it('names each refused service once, however many lines carry it', () => {
    expect(
      unofferedServiceIds(
        [
          { service_id: MATTRESS, quantity: 1 },
          { service_id: MATTRESS, quantity: 1 },
          { service_id: BULK, quantity: 1 },
        ],
        CAMBRIDGE_OFFERS,
      ),
    ).toEqual([MATTRESS])
  })

  describe('edits — a service already on the booking whose rule has since been removed', () => {
    const current = new Map([[MATTRESS, 2]])

    it('may be kept or reduced (a staff reduction that owes a refund must go through)', () => {
      expect(unofferedServiceIds([{ service_id: MATTRESS, quantity: 2 }], CAMBRIDGE_OFFERS, current)).toEqual([])
      expect(unofferedServiceIds([{ service_id: MATTRESS, quantity: 1 }], CAMBRIDGE_OFFERS, current)).toEqual([])
      expect(unofferedServiceIds([], CAMBRIDGE_OFFERS, current)).toEqual([])
    })

    it('may not be increased — the extra units would price at $0', () => {
      expect(unofferedServiceIds([{ service_id: MATTRESS, quantity: 3 }], CAMBRIDGE_OFFERS, current)).toEqual([
        MATTRESS,
      ])
    })

    it('an un-offered service not already on the booking may not be added', () => {
      expect(
        unofferedServiceIds([{ service_id: MATTRESS, quantity: 1 }], CAMBRIDGE_OFFERS, new Map([[BULK, 1]])),
      ).toEqual([MATTRESS])
    })
  })
})

// ── The durable enforcement lives in SQL ─────────────────────────────────────
// The repo has no SQL test harness, so (like client-monthly-billable-statuses)
// this reads the LATEST migration defining each booking RPC and pins the gate.
// A future CREATE OR REPLACE that drops it fails here instead of reopening $0
// bookings silently.

const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations')

/** Body of the newest definition of public.<fn> (the one prod ends up with). */
function currentDefinition(fn: string): string {
  const header = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`)
  const latest = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => header.test(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')))
    .at(-1)
  if (!latest) throw new Error(`No migration defines public.${fn}`)
  const sql = readFileSync(path.join(MIGRATIONS_DIR, latest), 'utf8')
  const start = sql.search(header)
  const body = /\$function\$([\s\S]*?)\$function\$/.exec(sql.slice(start))
  if (!body?.[1]) throw new Error(`Could not read the ${fn} body from ${latest}`)
  return body[1]
}

/** Comments stripped, whitespace collapsed, case folded. */
function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
    .toLowerCase()
}

describe.each([
  ['create_booking_with_capacity_check', 'p_collection_area_id'],
  ['create_mud_booking_with_capacity_check', 'v_area_id'],
  ['update_booking_items_in_place', 'v_booking.collection_area_id'],
] as const)('%s refuses services the area does not offer', (fn, areaExpr) => {
  const body = normalise(currentDefinition(fn))

  it('checks every item against the area’s service_rules', () => {
    expect(body).toContain(`from service_rules sr where sr.collection_area_id = ${areaExpr.toLowerCase()}`)
  })

  it('raises rather than pricing the item', () => {
    expect(body).toContain('is not offered in this collection area')
  })
})

describe('update_booking_items_in_place lets an edit keep or reduce an existing item', () => {
  it('compares the new quantity with what the booking already has', () => {
    const body = normalise(currentDefinition('update_booking_items_in_place'))
    expect(body).toContain('n.qty > coalesce((select sum(bi.no_services) from booking_item bi where bi.booking_id = p_booking_id and bi.service_id = n.service_id), 0)')
  })
})
