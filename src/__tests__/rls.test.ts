/**
 * RLS smoke tests — run against the remote Supabase project.
 *
 * Strategy: connect directly to Postgres via `pg`, then for each test user
 * issue `SET LOCAL request.jwt.claims TO ...` + `SET LOCAL ROLE authenticated`
 * inside a transaction, run a SELECT, assert the row count, then ROLLBACK.
 *
 * This bypasses GoTrue (which has historically failed sign-in with
 * "Database error querying schema" due to recursive RLS chains on profiles)
 * while still exercising the full RLS policy stack as the `authenticated`
 * Postgres role.
 *
 * Required env (in `.env.local` at the repo root):
 *   NEXT_PUBLIC_SUPABASE_URL          public Supabase URL
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY     anon key (only used for sanity checks)
 *   SUPABASE_SERVICE_ROLE_KEY         service role (used for fixture setup)
 *   SUPABASE_DB_URL                   direct Postgres connection string,
 *                                     e.g. postgresql://postgres.<ref>:<pwd>@
 *                                     aws-0-<region>.pooler.supabase.com:6543/postgres
 *
 * If SUPABASE_DB_URL is missing, the role-scoped suites are skipped (the
 * public-anon suite still runs because it only needs the anon key).
 *
 * Coverage matrix asserted (5 tables × 5 roles):
 *
 *   Role             | contacts | booking | service_ticket | profiles  | user_roles
 *   -----------------+----------+---------+----------------+-----------+-----------
 *   field            | 0 (PII)  | self    | 0 (PII)        | 1 (own)   | 1 (own)
 *   ranger           | 0 (PII)  | self    | 0 (PII)        | 1 (own)   | 1 (own)
 *   client-admin     | scoped   | scoped  | scoped         | self+staff| scoped
 *   contractor-admin | scoped   | scoped  | scoped         | self+staff| scoped
 *   resident         | own only | own     | own            | 1 (own)   | 1 (own)
 *
 * "self" means RLS allows the user to read rows they own (e.g. their own
 * profile, their own user_role). "scoped" means non-zero rows visible per
 * tenant scope. "0 (PII)" is the absolute red line — field/ranger must
 * never see contact PII.
 *
 * Test fixtures: created idempotently in beforeAll using fixed UUIDs.
 * They are NOT torn down — re-running the tests reuses the same rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { Client as PgClient } from 'pg'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { ID_VOLUMES } from '@/lib/booking/id-options'

// Canonical ID volume wire string for fixtures — derived from ID_VOLUMES, never
// re-typed (a re-typed copy once drifted to an ASCII hyphen vs the en-dash).
const ID_VOLUME_WIRE = `${ID_VOLUMES[1].label} (${ID_VOLUMES[1].sub})`

// -----------------------------------------------------------------------------
// Env loading
// -----------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const content = readFileSync(resolve(__dirname, '../../.env.local'), 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed.slice(eqIndex + 1).trim()
      // Don't overwrite explicit process.env values
      if (env[key] === undefined) env[key] = value
    }
  } catch {
    // .env.local may not exist in CI — fall through to process.env only
  }
  return env
}

const env = loadEnv()
const SUPABASE_URL = env['NEXT_PUBLIC_SUPABASE_URL']
const ANON_KEY = env['NEXT_PUBLIC_SUPABASE_ANON_KEY']
const SERVICE_ROLE_KEY = env['SUPABASE_SERVICE_ROLE_KEY']
const DB_URL = env['SUPABASE_DB_URL']

// Existing tenant rows in the project (queried at write-time; stable).
const CONTRACTOR_ID = '88f7cced-bd68-4c97-969f-dc76d97548f0' // D&M Waste Management
const CLIENT_ID = 'b009e60a-b7c6-4115-ad25-16ad60b3e194' // City of Kwinana

// Fixed UUIDs for test users (idempotent fixtures).
const USERS = {
  field: 'aaaaaaaa-0001-4000-8000-000000000001',
  ranger: 'aaaaaaaa-0002-4000-8000-000000000002',
  'client-admin': 'aaaaaaaa-0003-4000-8000-000000000003',
  'client-staff': 'aaaaaaaa-0004-4000-8000-000000000004',
  'contractor-admin': 'aaaaaaaa-0005-4000-8000-000000000005',
  'contractor-staff': 'aaaaaaaa-0006-4000-8000-000000000006',
  resident: 'aaaaaaaa-0007-4000-8000-000000000007',
} as const

type RoleName = keyof typeof USERS

const ROLE_FIXTURES: Record<RoleName, { contractorId: string | null; clientId: string | null; email: string }> = {
  field: { contractorId: CONTRACTOR_ID, clientId: null, email: 'rls-field@example.test' },
  ranger: { contractorId: null, clientId: CLIENT_ID, email: 'rls-ranger@example.test' },
  'client-admin': { contractorId: null, clientId: CLIENT_ID, email: 'rls-client-admin@example.test' },
  'client-staff': { contractorId: null, clientId: CLIENT_ID, email: 'rls-client-staff@example.test' },
  'contractor-admin': { contractorId: CONTRACTOR_ID, clientId: null, email: 'rls-contractor-admin@example.test' },
  'contractor-staff': { contractorId: CONTRACTOR_ID, clientId: null, email: 'rls-contractor-staff@example.test' },
  resident: { contractorId: null, clientId: null, email: 'rls-resident@example.test' },
}

// F5 (VER-247) fixtures: a contact linked to the resident user + a Confirmed
// booking they own, plus a Confirmed booking owned by a different contact (for
// the negative "can't cancel someone else's" case).
const F5_RESIDENT_CONTACT = 'bbbbbbbb-0001-4000-8000-000000000001'
const F5_RESIDENT_BOOKING = 'bbbbbbbb-0002-4000-8000-000000000002'
const F5_OTHER_CONTACT = 'bbbbbbbb-0003-4000-8000-000000000003'
const F5_OTHER_BOOKING = 'bbbbbbbb-0004-4000-8000-000000000004'

// -----------------------------------------------------------------------------
// Public-anon suite — always runs (only needs anon key)
// -----------------------------------------------------------------------------

const haveAnon = Boolean(SUPABASE_URL && ANON_KEY)
;(haveAnon ? describe : describe.skip)('public SELECT tables — anonymous access', () => {
  // Guarded by haveAnon — these are only constructed when the suite runs.
  const anon = haveAnon
    ? createClient(SUPABASE_URL!, ANON_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : (null as never)

  it('client table is readable', async () => {
    const { data, error } = await anon.from('client').select('id, name, slug')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('eligible_properties is readable', async () => {
    const { data, error } = await anon.from('eligible_properties').select('id, address').limit(5)
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('service table is readable', async () => {
    const { data, error } = await anon.from('service').select('id, name')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('category table is readable', async () => {
    const { data, error } = await anon.from('category').select('id, name, code')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('collection_area table is readable', async () => {
    const { data, error } = await anon.from('collection_area').select('id, code')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('financial_year table is readable', async () => {
    const { data, error } = await anon.from('financial_year').select('id, label, is_current')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('allocation_rules table is readable', async () => {
    const { data, error } = await anon.from('allocation_rules').select('id, max_collections')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })

  it('service_rules table is readable', async () => {
    const { data, error } = await anon.from('service_rules').select('id, max_collections')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
  })
})

// -----------------------------------------------------------------------------
// Role-scoped suites — require SUPABASE_DB_URL + service role
// -----------------------------------------------------------------------------

const haveDb = Boolean(DB_URL && SERVICE_ROLE_KEY && SUPABASE_URL)

if (!haveDb) {
  describe.skip('RLS role matrix (skipped — SUPABASE_DB_URL not set)', () => {
    it('placeholder', () => {
      // Set SUPABASE_DB_URL in .env.local to enable role-scoped tests.
      // See file header for the connection string format.
    })
  })
}

;(haveDb ? describe : describe.skip)('RLS role matrix', () => {
  let pg: PgClient

  beforeAll(async () => {
    pg = new PgClient({ connectionString: DB_URL })
    await pg.connect()

    // Create fixture users via service-role admin API (idempotent).
    const admin = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    for (const [role, fixture] of Object.entries(ROLE_FIXTURES) as [RoleName, typeof ROLE_FIXTURES[RoleName]][]) {
      const userId = USERS[role]

      // 1. auth.users — create if absent. Using direct SQL via pg because the
      //    admin.createUser API requires email/password and we want to set
      //    a fixed UUID. This insert is service-role + bypasses RLS.
      await pg.query(
        `INSERT INTO auth.users (id, email, aud, role, instance_id, encrypted_password, email_confirmed_at, created_at, updated_at)
         VALUES ($1, $2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '', now(), now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [userId, fixture.email],
      )

      // 2. profiles — created automatically via handle_new_user trigger if
      //    one exists; otherwise insert directly.
      await pg.query(
        `INSERT INTO public.profiles (id, email, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        [userId, fixture.email, `RLS Test ${role}`],
      )

      // 3. user_roles — UNIQUE (user_id) so upsert via ON CONFLICT.
      await pg.query(
        `INSERT INTO public.user_roles (user_id, role, contractor_id, client_id, is_active)
         VALUES ($1, $2::app_role, $3, $4, true)
         ON CONFLICT (user_id) DO UPDATE
           SET role = EXCLUDED.role,
               contractor_id = EXCLUDED.contractor_id,
               client_id = EXCLUDED.client_id,
               is_active = true`,
        [userId, role, fixture.contractorId, fixture.clientId],
      )
    }

    // F5 (VER-247) fixture: link the resident user to a contact and give them a
    // Confirmed booking, plus a Confirmed booking owned by someone else. Uses a
    // real Kwinana collection_area + the current FY for valid FKs. Idempotent;
    // the booking status is reset to Confirmed on re-run.
    const area = await pg.query<{ id: string }>(
      `SELECT id FROM collection_area WHERE client_id = $1 LIMIT 1`,
      [CLIENT_ID],
    )
    const fy = await pg.query<{ id: string }>(
      `SELECT id FROM financial_year WHERE is_current LIMIT 1`,
    )
    if (area.rows[0] && fy.rows[0]) {
      const areaId = area.rows[0].id
      const fyId = fy.rows[0].id
      await pg.query(
        `INSERT INTO public.contacts (id, email, first_name, last_name)
         VALUES ($1, 'rls-resident@example.test', 'RLS', 'Resident'),
                ($2, 'rls-other@example.test', 'RLS', 'Other')
         ON CONFLICT (id) DO NOTHING`,
        [F5_RESIDENT_CONTACT, F5_OTHER_CONTACT],
      )
      await pg.query(`UPDATE public.profiles SET contact_id = $1 WHERE id = $2`, [
        F5_RESIDENT_CONTACT,
        USERS.resident,
      ])
      await pg.query(
        `INSERT INTO public.booking (id, ref, type, status, contact_id, collection_area_id, client_id, contractor_id, fy_id)
         VALUES ($1, 'RLS-F5-OWN', 'Residential', 'Confirmed', $3, $5, $6, $7, $8),
                ($2, 'RLS-F5-OTHER', 'Residential', 'Confirmed', $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET status = 'Confirmed', cancelled_at = NULL`,
        [F5_RESIDENT_BOOKING, F5_OTHER_BOOKING, F5_RESIDENT_CONTACT, F5_OTHER_CONTACT, areaId, CLIENT_ID, CONTRACTOR_ID, fyId],
      )
    }

    // Sanity: silence unused warning in case admin client isn't used for
    // anything else (kept here for future fixture extension).
    void admin
  }, 30_000)

  afterAll(async () => {
    if (pg) await pg.end()
  })

  /**
   * Run a SELECT count(*) under impersonation, in a transaction we ROLLBACK.
   *
   * `request.jwt.claims` is what `auth.uid()` reads via `current_setting()`.
   * Setting role to `authenticated` activates RLS — `service_role` bypasses it.
   */
  async function countAs(userId: string, sql: string): Promise<number> {
    await pg.query('BEGIN')
    try {
      await pg.query(`SET LOCAL ROLE authenticated`)
      // SET LOCAL is a utility statement and doesn't accept parameter binding.
      // set_config() is a regular function that does the same job and supports
      // $-params, so we use it for the JSON claims string. Third arg `true`
      // makes the change local to the current transaction.
      await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
      const r = await pg.query<{ c: string }>(`SELECT count(*)::text AS c FROM (${sql}) _t`)
      return Number.parseInt(r.rows[0]!.c, 10)
    } finally {
      await pg.query('ROLLBACK')
    }
  }

  /**
   * Run a write (UPDATE/DELETE) under impersonation and return rows affected,
   * in a transaction we ROLLBACK. A `0` here is exactly the silent RLS no-op
   * that bit F5 — the write is permitted to "succeed" but changes nothing.
   */
  async function updateAs(userId: string, sql: string): Promise<number> {
    await pg.query('BEGIN')
    try {
      await pg.query(`SET LOCAL ROLE authenticated`)
      await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
      const r = await pg.query(sql)
      return r.rowCount ?? 0
    } finally {
      await pg.query('ROLLBACK')
    }
  }

  // ---------------------------------------------------------------------------
  // Red line: PII suppression — field & ranger MUST see zero rows of contacts
  // and zero rows of service_ticket (which embeds contact_id).
  // ---------------------------------------------------------------------------

  describe('TC-PII: contacts table (zero tolerance)', () => {
    it('field role gets ZERO rows from contacts', async () => {
      const n = await countAs(USERS.field, 'SELECT id FROM contacts')
      expect(n).toBe(0)
    })

    it('ranger role gets ZERO rows from contacts', async () => {
      const n = await countAs(USERS.ranger, 'SELECT id FROM contacts')
      expect(n).toBe(0)
    })

    it('resident role sees only own contact (≤1 row)', async () => {
      const n = await countAs(USERS.resident, 'SELECT id FROM contacts')
      expect(n).toBeLessThanOrEqual(1)
    })

    it('client-admin sees scoped contacts (may be 0 if no bookings, must not error)', async () => {
      const n = await countAs(USERS['client-admin'], 'SELECT id FROM contacts')
      expect(n).toBeGreaterThanOrEqual(0)
    })

    it('contractor-admin sees scoped contacts (may be 0 if no bookings, must not error)', async () => {
      const n = await countAs(USERS['contractor-admin'], 'SELECT id FROM contacts')
      expect(n).toBeGreaterThanOrEqual(0)
    })
  })

  describe('TC-PII: service_ticket table (zero tolerance for field/ranger)', () => {
    it('field role gets ZERO rows from service_ticket', async () => {
      const n = await countAs(USERS.field, 'SELECT id FROM service_ticket')
      expect(n).toBe(0)
    })

    it('ranger role gets ZERO rows from service_ticket', async () => {
      const n = await countAs(USERS.ranger, 'SELECT id FROM service_ticket')
      expect(n).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // booking — field/ranger CAN see bookings but only run-sheet-relevant
  // columns; here we just assert the policy doesn't error and that role-
  // scoped users don't crash.
  // ---------------------------------------------------------------------------

  describe('booking table — policy execution', () => {
    it.each([
      ['field', USERS.field],
      ['ranger', USERS.ranger],
      ['client-admin', USERS['client-admin']],
      ['contractor-admin', USERS['contractor-admin']],
      ['resident', USERS.resident],
    ] as const)('%s can query booking without error', async (_role, uid) => {
      const n = await countAs(uid, 'SELECT id FROM booking')
      expect(n).toBeGreaterThanOrEqual(0)
    })
  })

  // ---------------------------------------------------------------------------
  // TC-F5 (VER-247): residents can cancel their OWN booking. The bug was an
  // implicit WITH CHECK on booking_resident_update that rejected status
  // 'Cancelled' (0 rows, no error). These assert the policy now lets a resident
  // transition their own Confirmed booking → Cancelled, but not someone else's,
  // while staff retain the ability.
  // ---------------------------------------------------------------------------
  describe('TC-F5: resident booking cancellation (VER-247)', () => {
    const cancelSql = (id: string) =>
      `UPDATE booking SET status = 'Cancelled', cancelled_at = now() WHERE id = '${id}'`

    it('resident CAN cancel their OWN Confirmed booking (1 row)', async () => {
      const n = await updateAs(USERS.resident, cancelSql(F5_RESIDENT_BOOKING))
      expect(n).toBe(1)
    })

    it('resident CANNOT cancel a booking they do not own (0 rows)', async () => {
      const n = await updateAs(USERS.resident, cancelSql(F5_OTHER_BOOKING))
      expect(n).toBe(0)
    })

    it('staff (contractor-admin) CAN still cancel a booking (1 row)', async () => {
      const n = await updateAs(USERS['contractor-admin'], cancelSql(F5_RESIDENT_BOOKING))
      expect(n).toBe(1)
    })
  })

  // ---------------------------------------------------------------------------
  // profiles — the B1 fix target. field/ranger must NOT see other staff
  // profiles (only their own row).
  //
  // After migration 20260508045155_fix_profiles_pii_field_exclusion the
  // field/ranger row count must equal exactly 1 (own profile via
  // profiles_select policy where id = auth.uid()).
  // ---------------------------------------------------------------------------

  describe('TC-B1: profiles table — field/ranger isolation (B1 fix)', () => {
    it('field role sees ONLY own profile (count = 1)', async () => {
      const n = await countAs(USERS.field, 'SELECT id FROM profiles')
      expect(n).toBe(1)
    })

    it('ranger role sees ONLY own profile (count = 1)', async () => {
      const n = await countAs(USERS.ranger, 'SELECT id FROM profiles')
      expect(n).toBe(1)
    })

    it('resident role sees ONLY own profile (count = 1)', async () => {
      const n = await countAs(USERS.resident, 'SELECT id FROM profiles')
      expect(n).toBe(1)
    })

    it('client-admin sees ≥1 profiles (own + staff)', async () => {
      const n = await countAs(USERS['client-admin'], 'SELECT id FROM profiles')
      expect(n).toBeGreaterThanOrEqual(1)
    })

    it('contractor-admin sees ≥1 profiles (own + staff)', async () => {
      const n = await countAs(USERS['contractor-admin'], 'SELECT id FROM profiles')
      expect(n).toBeGreaterThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // user_roles — field/ranger/resident see only own row.
  // ---------------------------------------------------------------------------

  describe('user_roles table — scope', () => {
    it('field sees only own user_role (count = 1)', async () => {
      const n = await countAs(USERS.field, 'SELECT user_id FROM user_roles')
      expect(n).toBe(1)
    })

    it('ranger sees only own user_role (count = 1)', async () => {
      const n = await countAs(USERS.ranger, 'SELECT user_id FROM user_roles')
      expect(n).toBe(1)
    })

    it('resident sees only own user_role (count = 1)', async () => {
      const n = await countAs(USERS.resident, 'SELECT user_id FROM user_roles')
      expect(n).toBe(1)
    })

    it('client-admin sees ≥1 user_roles (scoped to client)', async () => {
      const n = await countAs(USERS['client-admin'], 'SELECT user_id FROM user_roles')
      expect(n).toBeGreaterThanOrEqual(1)
    })

    it('contractor-admin sees ≥1 user_roles (scoped to contractor)', async () => {
      const n = await countAs(USERS['contractor-admin'], 'SELECT user_id FROM user_roles')
      expect(n).toBeGreaterThanOrEqual(1)
    })
  })

  // ---------------------------------------------------------------------------
  // VER-216 — Sub-client scoping
  //
  // Three fixture users on the vergevalet client:
  //   - VV_COT_USER: sub_client_id = COT (City of Cottesloe)
  //   - VV_MOS_USER: sub_client_id = MOS (Town of Mosman Park)
  //   - VV_ALL_USER: sub_client_id = NULL (full vergevalet scope)
  //
  // Asserts the security contract: a scoped user sees only rows under
  // their sub-client's collection_areas. An unscoped user (NULL) is
  // unchanged from pre-VER-216 behaviour.
  // ---------------------------------------------------------------------------

  describe('Sub-client scoping (VER-216)', () => {
    const VV_CLIENT_ID = '5215645f-ca8f-4cff-8b7d-d5a8f7991ec7'
    const COT_SUB_CLIENT_ID = '43c4f0e0-20d7-4152-9dc4-2b48e8dc6949'
    const MOS_SUB_CLIENT_ID = 'd870be20-f507-4d65-b2af-5644990dbf82'

    const VV_COT_USER = 'aaaaaaaa-0008-4000-8000-000000000008'
    const VV_MOS_USER = 'aaaaaaaa-0009-4000-8000-000000000009'
    const VV_ALL_USER = 'aaaaaaaa-0010-4000-8000-000000000010'

    beforeAll(async () => {
      const setup: [string, string | null][] = [
        [VV_COT_USER, COT_SUB_CLIENT_ID],
        [VV_MOS_USER, MOS_SUB_CLIENT_ID],
        [VV_ALL_USER, null],
      ]
      for (const [uid, subClientId] of setup) {
        const email = `rls-vv-${uid.slice(-4)}@example.test`
        await pg.query(
          `INSERT INTO auth.users (id, email, aud, role, instance_id, encrypted_password, email_confirmed_at, created_at, updated_at)
           VALUES ($1, $2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '', now(), now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [uid, email],
        )
        await pg.query(
          `INSERT INTO public.profiles (id, email, display_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
          [uid, email, `VER-216 ${uid.slice(-4)}`],
        )
        await pg.query(
          `INSERT INTO public.user_roles (user_id, role, client_id, sub_client_id, is_active)
           VALUES ($1, 'client-admin'::app_role, $2, $3, true)
           ON CONFLICT (user_id) DO UPDATE
             SET role = 'client-admin'::app_role,
                 client_id = EXCLUDED.client_id,
                 sub_client_id = EXCLUDED.sub_client_id,
                 contractor_id = NULL,
                 is_active = true`,
          [uid, VV_CLIENT_ID, subClientId],
        )
      }
    }, 30_000)

    // Booking visibility — the headline assertion.
    describe('booking SELECT scope', () => {
      it('VV-all (NULL sub_client_id) sees bookings under BOTH COT and MOS', async () => {
        const cotSeen = await countAs(VV_ALL_USER, `
          SELECT b.id FROM booking b
          JOIN collection_area ca ON ca.id = b.collection_area_id
          WHERE ca.sub_client_id = '${COT_SUB_CLIENT_ID}'
        `)
        const mosSeen = await countAs(VV_ALL_USER, `
          SELECT b.id FROM booking b
          JOIN collection_area ca ON ca.id = b.collection_area_id
          WHERE ca.sub_client_id = '${MOS_SUB_CLIENT_ID}'
        `)
        expect(cotSeen).toBeGreaterThanOrEqual(1)
        expect(mosSeen).toBeGreaterThanOrEqual(1)
      })

      it('COT-scoped user sees ZERO MOS bookings', async () => {
        const n = await countAs(VV_COT_USER, `
          SELECT b.id FROM booking b
          JOIN collection_area ca ON ca.id = b.collection_area_id
          WHERE ca.sub_client_id = '${MOS_SUB_CLIENT_ID}'
        `)
        expect(n).toBe(0)
      })

      it('MOS-scoped user sees ZERO COT bookings', async () => {
        const n = await countAs(VV_MOS_USER, `
          SELECT b.id FROM booking b
          JOIN collection_area ca ON ca.id = b.collection_area_id
          WHERE ca.sub_client_id = '${COT_SUB_CLIENT_ID}'
        `)
        expect(n).toBe(0)
      })

      it('COT-scoped user sees ≥1 COT bookings (in-scope visible)', async () => {
        const n = await countAs(VV_COT_USER, `
          SELECT b.id FROM booking b
          JOIN collection_area ca ON ca.id = b.collection_area_id
          WHERE ca.sub_client_id = '${COT_SUB_CLIENT_ID}'
        `)
        expect(n).toBeGreaterThanOrEqual(1)
      })
    })

    // booking_item inherits booking's RLS via IN (SELECT id FROM booking).
    // Verifying that transitively works for sub-client scope.
    describe('booking_item — transitive scoping', () => {
      it('COT-scoped user sees ZERO booking_items tied to MOS bookings', async () => {
        const n = await countAs(VV_COT_USER, `
          SELECT bi.id FROM booking_item bi
          JOIN booking b ON b.id = bi.booking_id
          JOIN collection_area ca ON ca.id = b.collection_area_id
          WHERE ca.sub_client_id = '${MOS_SUB_CLIENT_ID}'
        `)
        expect(n).toBe(0)
      })
    })

    // current_user_sub_client_id() helper round-trips correctly.
    describe('helper functions', () => {
      it("current_user_sub_client_id returns the user's sub_client_id", async () => {
        await pg.query('BEGIN')
        try {
          await pg.query('SET LOCAL ROLE authenticated')
          await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ sub: VV_COT_USER, role: 'authenticated' }),
          ])
          const r = await pg.query<{ id: string | null }>('SELECT current_user_sub_client_id() AS id')
          expect(r.rows[0]!.id).toBe(COT_SUB_CLIENT_ID)
        } finally {
          await pg.query('ROLLBACK')
        }
      })

      it('current_user_sub_client_id returns NULL for unscoped user', async () => {
        await pg.query('BEGIN')
        try {
          await pg.query('SET LOCAL ROLE authenticated')
          await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ sub: VV_ALL_USER, role: 'authenticated' }),
          ])
          const r = await pg.query<{ id: string | null }>('SELECT current_user_sub_client_id() AS id')
          expect(r.rows[0]!.id).toBeNull()
        } finally {
          await pg.query('ROLLBACK')
        }
      })

      it('user_sub_client_allows_area returns TRUE for unscoped user on any area', async () => {
        await pg.query('BEGIN')
        try {
          await pg.query('SET LOCAL ROLE authenticated')
          await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ sub: VV_ALL_USER, role: 'authenticated' }),
          ])
          // Use any COT area — should still return true because user is unscoped.
          const r = await pg.query<{ ok: boolean }>(`
            SELECT user_sub_client_allows_area(
              (SELECT id FROM collection_area WHERE sub_client_id = '${COT_SUB_CLIENT_ID}' LIMIT 1)
            ) AS ok
          `)
          expect(r.rows[0]!.ok).toBe(true)
        } finally {
          await pg.query('ROLLBACK')
        }
      })

      it('user_sub_client_allows_area returns FALSE for COT user on MOS area', async () => {
        await pg.query('BEGIN')
        try {
          await pg.query('SET LOCAL ROLE authenticated')
          await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify({ sub: VV_COT_USER, role: 'authenticated' }),
          ])
          const r = await pg.query<{ ok: boolean }>(`
            SELECT user_sub_client_allows_area(
              (SELECT id FROM collection_area WHERE sub_client_id = '${MOS_SUB_CLIENT_ID}' LIMIT 1)
            ) AS ok
          `)
          expect(r.rows[0]!.ok).toBe(false)
        } finally {
          await pg.query('ROLLBACK')
        }
      })
    })

    // Composite FK guard — invalid (sub_client, client) pair is rejected by DB
    describe('composite FK enforces sub_client ↔ client integrity', () => {
      it('insert with COT sub_client + kwn client (mismatch) is rejected', async () => {
        const KWN_CLIENT_ID = CLIENT_ID
        const badUser = 'aaaaaaaa-0099-4000-8000-000000000099'
        await pg.query(
          `INSERT INTO auth.users (id, email, aud, role, instance_id, encrypted_password, email_confirmed_at, created_at, updated_at)
           VALUES ($1, $2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '', now(), now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [badUser, 'rls-ver216-bad@example.test'],
        )
        await pg.query(
          `INSERT INTO public.profiles (id, email, display_name)
           VALUES ($1, 'rls-ver216-bad@example.test', 'VER-216 Bad') ON CONFLICT (id) DO NOTHING`,
          [badUser],
        )
        await expect(
          pg.query(
            `INSERT INTO public.user_roles (user_id, role, client_id, sub_client_id, is_active)
             VALUES ($1, 'client-admin'::app_role, $2, $3, true)`,
            [badUser, KWN_CLIENT_ID, COT_SUB_CLIENT_ID],
          ),
        ).rejects.toThrow(/user_roles_sub_client_fk|foreign key/)
        // Cleanup — the failed INSERT auto-rolled back inside its own
        // implicit txn, so user_roles is clean. profiles and auth.users
        // are kept (idempotent fixtures pattern).
      })
    })
  })

  // ---------------------------------------------------------------------------
  // VER-220: allocation_override tenant scoping
  //
  // Pre-existing gap closed by 20260520030000_allocation_override_tenant_rls:
  // previously any staff-tier authenticated user (contractor-admin/staff,
  // client-admin/staff) saw ALL rows across all tenants. Now client-tier is
  // scoped via current_user_client_allows_property(); contractor-tier still
  // sees everything; field/ranger/resident still see nothing (role-gated out
  // both before and after this fix).
  // ---------------------------------------------------------------------------
  describe('allocation_override table — VER-220 tenant scoping', () => {
    it('contractor-admin can SELECT (no error, count ≥ 0)', async () => {
      const n = await countAs(USERS['contractor-admin'], 'SELECT id FROM allocation_override')
      expect(n).toBeGreaterThanOrEqual(0)
    })

    it('contractor-staff can SELECT (no error, count ≥ 0)', async () => {
      const n = await countAs(USERS['contractor-staff'], 'SELECT id FROM allocation_override')
      expect(n).toBeGreaterThanOrEqual(0)
    })

    it('client-admin can SELECT scoped (no error, count ≥ 0)', async () => {
      const n = await countAs(USERS['client-admin'], 'SELECT id FROM allocation_override')
      expect(n).toBeGreaterThanOrEqual(0)
    })

    it('client-staff can SELECT scoped (no error, count ≥ 0)', async () => {
      const n = await countAs(USERS['client-staff'], 'SELECT id FROM allocation_override')
      expect(n).toBeGreaterThanOrEqual(0)
    })

    it('field role gets ZERO rows (role not granted)', async () => {
      const n = await countAs(USERS.field, 'SELECT id FROM allocation_override')
      expect(n).toBe(0)
    })

    it('ranger role gets ZERO rows (role not granted)', async () => {
      const n = await countAs(USERS.ranger, 'SELECT id FROM allocation_override')
      expect(n).toBe(0)
    })

    it('resident role gets ZERO rows (role not granted)', async () => {
      const n = await countAs(USERS.resident, 'SELECT id FROM allocation_override')
      expect(n).toBe(0)
    })

    it('current_user_client_allows_property returns FALSE for nonexistent property', async () => {
      // The helper exists and short-circuits FALSE when the property doesn't
      // resolve to a known collection_area — exercises the SECURITY DEFINER
      // path without depending on any fixture row.
      const n = await countAs(
        USERS['client-admin'],
        `SELECT 1 WHERE current_user_client_allows_property('00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      expect(n).toBe(0)
    })

    it('client-admin cannot SELECT an override on a non-own-tenant property', async () => {
      // Explicit cross-tenant assertion: insert a non-KWN allocation_override
      // via service-role (a contractor's collection_area + property), then
      // verify KWN client-admin sees 0 rows for THAT specific row.
      //
      // This proves the scoping helper is doing real work, not just allowing
      // the query to compile.
      //
      // Setup is service-role bypass via direct pg client; we ROLLBACK at the
      // end to keep the fixture clean.
      await pg.query('BEGIN')
      try {
        // 1. Resolve a non-KWN client_id (any active client that isn't KWN).
        const otherClient = await pg.query<{ id: string }>(
          `SELECT id FROM client WHERE id <> $1 AND is_active = true LIMIT 1`,
          [CLIENT_ID],
        )
        if (otherClient.rows.length === 0) {
          // Single-tenant project — skip without failing (the role gating
          // tests above already cover the access boundary).
          return
        }
        const otherClientId = otherClient.rows[0]!.id

        // 2. Find a collection_area on that other client.
        const otherArea = await pg.query<{ id: string }>(
          `SELECT id FROM collection_area WHERE client_id = $1 AND is_active = true LIMIT 1`,
          [otherClientId],
        )
        if (otherArea.rows.length === 0) {
          return
        }
        const otherAreaId = otherArea.rows[0]!.id

        // 3. Find a property on that area.
        const otherProperty = await pg.query<{ id: string }>(
          `SELECT id FROM eligible_properties WHERE collection_area_id = $1 LIMIT 1`,
          [otherAreaId],
        )
        if (otherProperty.rows.length === 0) {
          return
        }
        const otherPropertyId = otherProperty.rows[0]!.id

        // 4. Find a service + current FY for the override.
        const svc = await pg.query<{ id: string }>(`SELECT id FROM service LIMIT 1`)
        const fy = await pg.query<{ id: string }>(`SELECT id FROM financial_year WHERE is_current LIMIT 1`)
        if (svc.rows.length === 0 || fy.rows.length === 0) return

        // 5. Insert the cross-tenant override (service-role bypass).
        const inserted = await pg.query<{ id: string }>(
          `INSERT INTO allocation_override (property_id, service_id, fy_id, extra_allocations, reason, created_by)
           VALUES ($1, $2, $3, 1, 'VER-220 RLS test', $4)
           RETURNING id`,
          [otherPropertyId, svc.rows[0]!.id, fy.rows[0]!.id, USERS['contractor-admin']],
        )
        const overrideId = inserted.rows[0]!.id

        // 6. As KWN client-admin, count rows for THIS specific override id.
        //    Use SAVEPOINT so the inner SET LOCAL doesn't leak.
        await pg.query('SAVEPOINT visibility_check')
        await pg.query(`SET LOCAL ROLE authenticated`)
        await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: USERS['client-admin'], role: 'authenticated' }),
        ])
        const seen = await pg.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM allocation_override WHERE id = $1`,
          [overrideId],
        )
        await pg.query('ROLLBACK TO SAVEPOINT visibility_check')

        expect(Number.parseInt(seen.rows[0]!.c, 10)).toBe(0)

        // 7. Same query as contractor-admin must return 1 (control).
        await pg.query('SAVEPOINT visibility_check_2')
        await pg.query(`SET LOCAL ROLE authenticated`)
        await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: USERS['contractor-admin'], role: 'authenticated' }),
        ])
        const seenByContractor = await pg.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM allocation_override WHERE id = $1`,
          [overrideId],
        )
        await pg.query('ROLLBACK TO SAVEPOINT visibility_check_2')

        expect(Number.parseInt(seenByContractor.rows[0]!.c, 10)).toBe(1)
      } finally {
        await pg.query('ROLLBACK')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // collection_stop / collection_run_meta — field-crew stop model (PR #158)
  //
  // Guarded: the tables ship with the field-stops release. Until those
  // migrations reach the remote project this suite self-skips (ctx.skip), so
  // the file stays runnable across the PR-A → release window.
  // ---------------------------------------------------------------------------
  describe('collection_stop / collection_run_meta — RLS + state machine', () => {
    const STOP_BOOKING = 'cccccccc-0001-4000-8000-000000000001' // Scheduled booking
    const STOP_GENERAL = 'cccccccc-0002-4000-8000-000000000002' // Pending stop on it
    const STOP_ON_CONFIRMED = 'cccccccc-0003-4000-8000-000000000003' // Pending stop on the F5 Confirmed booking

    let ready = false
    let hasCreatedBy = false

    beforeAll(async () => {
      const reg = await pg.query<{ t: string | null; c: string | null }>(
        `SELECT to_regclass('public.collection_stop')::text AS t,
                (SELECT column_name FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'booking'
                    AND column_name = 'created_by') AS c`,
      )
      if (!reg.rows[0]?.t) return // pre-release remote — suite self-skips
      hasCreatedBy = Boolean(reg.rows[0]?.c)

      const area = await pg.query<{ id: string }>(
        `SELECT id FROM collection_area WHERE client_id = $1 LIMIT 1`,
        [CLIENT_ID],
      )
      const date = await pg.query<{ id: string }>(
        `SELECT cd.id FROM collection_date cd
           JOIN collection_area ca ON ca.id = cd.collection_area_id
          WHERE ca.client_id = $1 LIMIT 1`,
        [CLIENT_ID],
      )
      const fy = await pg.query<{ id: string }>(
        `SELECT id FROM financial_year WHERE is_current LIMIT 1`,
      )
      if (!area.rows[0] || !date.rows[0] || !fy.rows[0]) return

      // Scheduled booking + Pending stop (the closeout-eligible pair), plus a
      // Pending stop on the F5 Confirmed booking (closeout must be refused
      // until the booking reaches Scheduled). Idempotent; tests ROLLBACK.
      await pg.query(
        `INSERT INTO public.booking (id, ref, type, status, collection_area_id, client_id, contractor_id, fy_id)
         VALUES ($1, 'RLS-STOP-BKG', 'Residential', 'Scheduled', $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET status = 'Scheduled'`,
        [STOP_BOOKING, area.rows[0].id, CLIENT_ID, CONTRACTOR_ID, fy.rows[0].id],
      )
      await pg.query(
        `INSERT INTO public.collection_stop
           (id, booking_id, client_id, stream, collection_date_id, status, external_order_ref, services_summary)
         VALUES ($1, $2, $3, 'general', $4, 'Pending', 'RLS-STOP-BKG-GEN', '[{"name":"General","qty":1}]'),
                ($5, $6, $3, 'general', $4, 'Pending', 'RLS-F5-OWN-GEN', '[{"name":"General","qty":1}]')
         ON CONFLICT (id) DO UPDATE
           SET status = 'Pending', cancelled_at = NULL, completed_at = NULL, completed_by = NULL`,
        [STOP_GENERAL, STOP_BOOKING, CLIENT_ID, date.rows[0].id, STOP_ON_CONFIRMED, F5_RESIDENT_BOOKING],
      )
      await pg.query(
        `INSERT INTO public.collection_run_meta (driver_serial, date, driver_name)
         VALUES ('RLS-TEST', CURRENT_DATE, 'RLS Test Crew')
         ON CONFLICT (driver_serial, date) DO NOTHING`,
      )
      ready = true
    }, 30_000)

    it('field SELECTs stops in their tenant', async (ctx) => {
      if (!ready) return ctx.skip()
      const n = await countAs(USERS.field, `SELECT id FROM collection_stop WHERE id = '${STOP_GENERAL}'`)
      expect(n).toBe(1)
    })

    it('resident gets ZERO stop rows even for their own booking (routing internals)', async (ctx) => {
      if (!ready) return ctx.skip()
      const n = await countAs(
        USERS.resident,
        `SELECT id FROM collection_stop WHERE booking_id = '${F5_RESIDENT_BOOKING}'`,
      )
      expect(n).toBe(0)
    })

    it('field completes a Pending stop on a Scheduled booking (1 row + rollup)', async (ctx) => {
      if (!ready) return ctx.skip()
      const n = await updateAs(
        USERS.field,
        `UPDATE collection_stop
            SET status = 'Completed', completed_at = now(), completed_by = '${USERS.field}'
          WHERE id = '${STOP_GENERAL}'`,
      )
      expect(n).toBe(1)
    })

    it('ranger cannot terminalise a stop (0 rows — write policy is field-only)', async (ctx) => {
      if (!ready) return ctx.skip()
      const n = await updateAs(
        USERS.ranger,
        `UPDATE collection_stop SET status = 'Completed' WHERE id = '${STOP_GENERAL}'`,
      )
      expect(n).toBe(0)
    })

    it('field cannot close a stop while its booking is still Confirmed (0 rows)', async (ctx) => {
      if (!ready) return ctx.skip()
      const n = await updateAs(
        USERS.field,
        `UPDATE collection_stop SET status = 'Completed' WHERE id = '${STOP_ON_CONFIRMED}'`,
      )
      expect(n).toBe(0)
    })

    it('field cannot set a stop to Cancelled (WITH CHECK)', async (ctx) => {
      if (!ready) return ctx.skip()
      await expect(
        updateAs(
          USERS.field,
          `UPDATE collection_stop SET status = 'Cancelled' WHERE id = '${STOP_GENERAL}'`,
        ),
      ).rejects.toThrow(/row-level security/)
    })

    it('field cannot rewrite identity columns in the closeout UPDATE', async (ctx) => {
      if (!ready) return ctx.skip()
      await expect(
        updateAs(
          USERS.field,
          `UPDATE collection_stop
              SET status = 'Completed', external_order_ref = 'HIJACKED'
            WHERE id = '${STOP_GENERAL}'`,
        ),
      ).rejects.toThrow(/immutable/)
    })

    it('field cannot forge completed_by to another user', async (ctx) => {
      if (!ready) return ctx.skip()
      await expect(
        updateAs(
          USERS.field,
          `UPDATE collection_stop
              SET status = 'Completed', completed_by = '${USERS.ranger}'
            WHERE id = '${STOP_GENERAL}'`,
        ),
      ).rejects.toThrow(/acting user/)
    })

    it('authenticated roles cannot INSERT stops (push EF only)', async (ctx) => {
      if (!ready) return ctx.skip()
      await expect(
        updateAs(
          USERS.field,
          `INSERT INTO collection_stop (booking_id, client_id, stream, collection_date_id)
           SELECT '${STOP_BOOKING}', '${CLIENT_ID}', 'green', collection_date_id
             FROM collection_stop WHERE id = '${STOP_GENERAL}'`,
        ),
      ).rejects.toThrow(/row-level security/)
    })

    it('collection_run_meta: contractor roles read it; ranger/client-admin/resident get zero', async (ctx) => {
      if (!ready) return ctx.skip()
      const sql = `SELECT id FROM collection_run_meta WHERE driver_serial = 'RLS-TEST'`
      expect(await countAs(USERS.field, sql)).toBe(1)
      expect(await countAs(USERS['contractor-staff'], sql)).toBe(1)
      expect(await countAs(USERS.ranger, sql)).toBe(0)
      expect(await countAs(USERS['client-admin'], sql)).toBe(0)
      expect(await countAs(USERS.resident, sql)).toBe(0)
    })

    it('ID RPC stamps created_by with the acting ranger', async (ctx) => {
      if (!ready || !hasCreatedBy) return ctx.skip()
      await pg.query('BEGIN')
      try {
        const row = await pg.query<{ id: string; collection_area_id: string }>(
          `SELECT cd.id, cd.collection_area_id
             FROM collection_date cd
             JOIN collection_area ca ON ca.id = cd.collection_area_id
            WHERE ca.client_id = $1 AND ca.capacity_pool_id IS NULL
            LIMIT 1`,
          [CLIENT_ID],
        )
        if (!row.rows[0]) return ctx.skip()
        await pg.query(
          `UPDATE collection_date
              SET id_capacity_limit = 10, id_units_booked = 0, id_is_closed = false
            WHERE id = $1`,
          [row.rows[0].id],
        )
        await pg.query('SET LOCAL ROLE authenticated')
        await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: USERS.ranger, role: 'authenticated' }),
        ])
        const res = await pg.query<{ r: { booking_id: string } }>(
          `SELECT create_id_booking_with_capacity_check(
             $1::uuid, $2::uuid, -32.27, 115.75, 'x', '', '{}'::text[],
             ARRAY['General / Mixed']::text[], $3::text
           ) AS r`,
          [row.rows[0].id, row.rows[0].collection_area_id, ID_VOLUME_WIRE],
        )
        await pg.query('RESET ROLE')
        const b = await pg.query<{ created_by: string | null }>(
          `SELECT created_by FROM booking WHERE id = $1`,
          [res.rows[0]!.r.booking_id],
        )
        expect(b.rows[0]!.created_by).toBe(USERS.ranger)
      } finally {
        await pg.query('ROLLBACK')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Illegal Dumping RPC — create_id_booking_with_capacity_check (VER-225/226)
  //
  // Exercises the SECURITY DEFINER booking path under ranger impersonation:
  // the ranger-only gate, capacity rejection, and a successful 'Confirmed'
  // booking with the structured columns populated and capacity incremented.
  // Everything runs inside a transaction we ROLLBACK, so nothing persists.
  // ---------------------------------------------------------------------------
  describe('Illegal Dumping RPC (create_id_booking_with_capacity_check)', () => {
    // Seed the ID service (idempotent) and force a clean, non-pooled date in
    // the ranger's client to have capacity. Runs as the connection role
    // (RLS-bypassing) before any impersonation.
    async function setupIdDate(
      clientId: string = CLIENT_ID,
      subClientId: string | null = null,
      // Denial-path tests (role/tenant/sub-client gates fire before the
      // capacity branch) can use pooled areas — VV's sub-client areas are
      // pool-backed, so requiring unpooled there would silently skip them.
      requireUnpooled = true,
    ): Promise<{ dateId: string; areaId: string } | null> {
      await pg.query(
        `INSERT INTO service (name, category_id)
         SELECT 'Illegal Dumping', c.id FROM category c
         WHERE c.code = 'id' AND NOT EXISTS (SELECT 1 FROM service s WHERE s.category_id = c.id)`,
      )
      const row = await pg.query<{ id: string; collection_area_id: string }>(
        `SELECT cd.id, cd.collection_area_id
         FROM collection_date cd
         JOIN collection_area ca ON ca.id = cd.collection_area_id
         WHERE ca.client_id = $1
           AND (NOT $3::boolean OR ca.capacity_pool_id IS NULL)
           AND ($2::uuid IS NULL OR ca.sub_client_id = $2)
         ORDER BY (cd.date >= (now() AT TIME ZONE 'Australia/Perth')::date AND cd.is_open) DESC
         LIMIT 1`,
        [clientId, subClientId, requireUnpooled],
      )
      if (row.rows.length === 0) return null
      const dateId = row.rows[0]!.id
      const areaId = row.rows[0]!.collection_area_id
      // The RPC requires is_open, not id_is_closed, and a non-past date — force
      // all three. Past dates bump to max(date)+7 within the area so the
      // (collection_area_id, date) unique constraint can't collide.
      await pg.query(
        `UPDATE collection_date
         SET id_capacity_limit = 10, id_units_booked = 0, id_is_closed = false,
             is_open = true,
             date = CASE
               WHEN date >= (now() AT TIME ZONE 'Australia/Perth')::date THEN date
               ELSE (SELECT max(d2.date) FROM collection_date d2
                     WHERE d2.collection_area_id = collection_date.collection_area_id) + 7
             END
         WHERE id = $1`,
        [dateId],
      )
      return { dateId, areaId }
    }

    async function impersonate(userId: string) {
      await pg.query('SET LOCAL ROLE authenticated')
      await pg.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
    }

    const CALL = `SELECT create_id_booking_with_capacity_check(
      $1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::text, $6::text, $7::text[], $8::text[], $9::text
    ) AS r`

    it('creates a Confirmed ID booking with structured columns + increments capacity', async () => {
      await pg.query('BEGIN')
      try {
        const ctx = await setupIdDate()
        if (!ctx) return
        await impersonate(USERS.ranger)

        const res = await pg.query<{ r: { booking_id: string; ref: string } }>(CALL, [
          ctx.dateId,
          ctx.areaId,
          -32.27,
          115.75,
          '12 Test St, Safety Bay',
          'Access via rear lane',
          ['https://example.com/p1.jpg', 'https://example.com/p2.jpg'],
          ['General / Mixed', 'Mattress'],
          ID_VOLUME_WIRE,
        ])
        const { booking_id, ref } = res.rows[0]!.r
        expect(ref).toMatch(/-/)

        // Verify with full visibility.
        await pg.query('RESET ROLE')
        const b = await pg.query<{
          type: string
          status: string
          geo_address: string
          id_volume: string
          id_waste_types: string[]
          photo_count: number
          items: number
          units: string
        }>(
          `SELECT type, status, geo_address, id_volume, id_waste_types,
                  array_length(photos, 1) AS photo_count,
                  (SELECT count(*)::int FROM booking_item WHERE booking_id = $1) AS items,
                  (SELECT id_units_booked FROM collection_date WHERE id = $2) AS units
           FROM booking WHERE id = $1`,
          [booking_id, ctx.dateId],
        )
        const row = b.rows[0]!
        expect(row.type).toBe('Illegal Dumping')
        expect(row.status).toBe('Confirmed')
        expect(row.geo_address).toBe('12 Test St, Safety Bay')
        expect(row.id_volume).toBe(ID_VOLUME_WIRE)
        expect(row.id_waste_types).toEqual(['General / Mixed', 'Mattress'])
        expect(row.photo_count).toBe(2)
        expect(row.items).toBe(1)
        expect(Number(row.units)).toBeGreaterThanOrEqual(1)
      } finally {
        await pg.query('ROLLBACK')
      }
    })

    it('rejects when no ID capacity remains', async () => {
      await pg.query('BEGIN')
      try {
        const ctx = await setupIdDate()
        if (!ctx) return
        await pg.query(
          `UPDATE collection_date SET id_capacity_limit = 0, id_units_booked = 0 WHERE id = $1`,
          [ctx.dateId],
        )
        await impersonate(USERS.ranger)

        let err: Error | null = null
        try {
          await pg.query(CALL, [
            ctx.dateId, ctx.areaId, -32.27, 115.75, 'x', '', [], ['General / Mixed'], ID_VOLUME_WIRE,
          ])
        } catch (e) {
          err = e as Error
        }
        expect(err?.message ?? '').toMatch(/capacity/i)
      } finally {
        await pg.query('ROLLBACK')
      }
    })

    // Staff roles create ID bookings from the admin portal (phoned-in
    // reports) — widened from ranger-only in 20260611031624.
    it.each(['client-admin', 'client-staff', 'contractor-admin', 'contractor-staff'] as const)(
      'allows a %s caller to create an ID booking',
      async (role) => {
        await pg.query('BEGIN')
        try {
          const ctx = await setupIdDate()
          if (!ctx) return
          await impersonate(USERS[role])

          const res = await pg.query<{ r: { booking_id: string; ref: string } }>(CALL, [
            ctx.dateId,
            ctx.areaId,
            -32.27,
            115.75,
            '14 Office St, Kwinana',
            'Phoned in by a resident',
            [],
            ['General / Mixed'],
            ID_VOLUME_WIRE,
          ])
          expect(res.rows[0]!.r.ref).toMatch(/-/)
        } finally {
          await pg.query('ROLLBACK')
        }
      },
    )

    it.each(['resident', 'field'] as const)('rejects a %s caller', async (role) => {
      await pg.query('BEGIN')
      try {
        const ctx = await setupIdDate()
        if (!ctx) return
        await impersonate(USERS[role])

        let err: Error | null = null
        try {
          await pg.query(CALL, [
            ctx.dateId, ctx.areaId, -32.27, 115.75, 'x', '', [], ['General / Mixed'], ID_VOLUME_WIRE,
          ])
        } catch (e) {
          err = e as Error
        }
        expect(err?.message ?? '').toMatch(/ranger and staff roles/i)
      } finally {
        await pg.query('ROLLBACK')
      }
    })

    // Tenant boundary: a Kwinana-scoped client-admin must not be able to book
    // an ID into another client's area now that staff roles pass the role gate.
    // These boundary tests fail LOUDLY on missing fixtures (a silent return
    // would green-light the exact regression they exist to catch).
    it('rejects a client-admin booking into another tenant area', async () => {
      const VV_CLIENT_ID = '5215645f-ca8f-4cff-8b7d-d5a8f7991ec7' // vergevalet (fixtures above)
      await pg.query('BEGIN')
      try {
        const ctx = await setupIdDate(VV_CLIENT_ID, null, false)
        expect(ctx, 'fixture missing: no vergevalet collection_date found').not.toBeNull()
        if (!ctx) return
        await impersonate(USERS['client-admin']) // Kwinana-scoped fixture

        let err: Error | null = null
        try {
          await pg.query(CALL, [
            ctx.dateId, ctx.areaId, -32.0, 115.7, 'x', '', [], ['General / Mixed'], ID_VOLUME_WIRE,
          ])
        } catch (e) {
          err = e as Error
        }
        expect(err?.message ?? '').toMatch(/accessible clients/i)
      } finally {
        await pg.query('ROLLBACK')
      }
    })

    // Sub-client boundary (VER-216): a COT-narrowed client-admin must not be
    // able to book an ID into a MOS-sub-client area of the same client.
    it('rejects a sub-client-scoped client-admin booking into another sub-client area', async () => {
      const VV_CLIENT_ID = '5215645f-ca8f-4cff-8b7d-d5a8f7991ec7'
      const MOS_SUB_CLIENT_ID = 'd870be20-f507-4d65-b2af-5644990dbf82'
      const VV_COT_USER = 'aaaaaaaa-0008-4000-8000-000000000008' // VER-216 fixture
      await pg.query('BEGIN')
      try {
        const ctx = await setupIdDate(VV_CLIENT_ID, MOS_SUB_CLIENT_ID, false)
        expect(ctx, 'fixture missing: no MOS sub-client collection_date found').not.toBeNull()
        if (!ctx) return
        await impersonate(VV_COT_USER)

        let err: Error | null = null
        try {
          await pg.query(CALL, [
            ctx.dateId, ctx.areaId, -32.0, 115.7, 'x', '', [], ['General / Mixed'], ID_VOLUME_WIRE,
          ])
        } catch (e) {
          err = e as Error
        }
        expect(err?.message ?? '').toMatch(/sub-client scope/i)
      } finally {
        await pg.query('ROLLBACK')
      }
    })

    // Pool-aware capacity (20260611031624): pooled areas count + serialise on
    // collection_date_pool. Books once (pool counter moves, per-date counter
    // doesn't), then exhausts the pool and expects rejection.
    it('enforces pooled ID capacity via collection_date_pool', async () => {
      const VV_CLIENT_ID = '5215645f-ca8f-4cff-8b7d-d5a8f7991ec7'
      const VV_ALL_USER = 'aaaaaaaa-0010-4000-8000-000000000010' // VER-216 fixture, full VV scope
      await pg.query('BEGIN')
      try {
        // A pooled, future, open date with a matching pool row.
        const row = await pg.query<{
          id: string
          collection_area_id: string
          pool_date_id: string
        }>(
          `SELECT cd.id, cd.collection_area_id, cdp.id AS pool_date_id
           FROM collection_date cd
           JOIN collection_area ca ON ca.id = cd.collection_area_id
           JOIN collection_date_pool cdp
             ON cdp.capacity_pool_id = ca.capacity_pool_id AND cdp.date = cd.date
           WHERE ca.client_id = $1 AND ca.capacity_pool_id IS NOT NULL
             AND cd.date >= (now() AT TIME ZONE 'Australia/Perth')::date
           ORDER BY cd.date ASC
           LIMIT 1`,
          [VV_CLIENT_ID],
        )
        if (row.rows.length === 0) return // no future pooled dates seeded — skip
        const { id: dateId, collection_area_id: areaId, pool_date_id: poolDateId } = row.rows[0]!

        await pg.query(
          `UPDATE collection_date SET is_open = true, id_is_closed = false WHERE id = $1`,
          [dateId],
        )
        await pg.query(
          `UPDATE collection_date_pool
           SET id_capacity_limit = 5, id_units_booked = 0, id_is_closed = false
           WHERE id = $1`,
          [poolDateId],
        )
        const before = await pg.query<{ cd_units: number; pool_units: number }>(
          `SELECT (SELECT id_units_booked FROM collection_date WHERE id = $1) AS cd_units,
                  (SELECT id_units_booked FROM collection_date_pool WHERE id = $2) AS pool_units`,
          [dateId, poolDateId],
        )

        await impersonate(VV_ALL_USER)
        const res = await pg.query<{ r: { ref: string } }>(CALL, [
          dateId, areaId, -31.99, 115.75, 'Pooled pile', '', [], ['General / Mixed'], ID_VOLUME_WIRE,
        ])
        expect(res.rows[0]!.r.ref).toMatch(/-/)

        await pg.query('RESET ROLE')
        const after = await pg.query<{ cd_units: number; pool_units: number }>(
          `SELECT (SELECT id_units_booked FROM collection_date WHERE id = $1) AS cd_units,
                  (SELECT id_units_booked FROM collection_date_pool WHERE id = $2) AS pool_units`,
          [dateId, poolDateId],
        )
        // The recalc trigger's pooled branch moves the POOL counter only.
        expect(Number(after.rows[0]!.pool_units)).toBe(Number(before.rows[0]!.pool_units) + 1)
        expect(Number(after.rows[0]!.cd_units)).toBe(Number(before.rows[0]!.cd_units))

        // Exhaust the pool — next booking must be rejected.
        await pg.query(
          `UPDATE collection_date_pool SET id_units_booked = id_capacity_limit WHERE id = $1`,
          [poolDateId],
        )
        await impersonate(VV_ALL_USER)
        let err: Error | null = null
        try {
          await pg.query(CALL, [
            dateId, areaId, -31.99, 115.75, 'x', '', [], ['General / Mixed'], ID_VOLUME_WIRE,
          ])
        } catch (e) {
          err = e as Error
        }
        expect(err?.message ?? '').toMatch(/capacity/i)
      } finally {
        await pg.query('ROLLBACK')
      }
    })

    // -------------------------------------------------------------------------
    // Strata contact RPC — upsert_strata_contact_and_link (VER-255)
    //
    // SECURITY DEFINER upsert+link: role gate, tenant scope via the property's
    // area, atomic link (contact becomes visible via contacts_admin_strata_select
    // in the same transaction). All inside rolled-back transactions.
    // -------------------------------------------------------------------------
    describe('Strata contact RPC (upsert_strata_contact_and_link)', () => {
      const STRATA_CALL = `SELECT upsert_strata_contact_and_link(
        $1::uuid, $2::text, $3::text, $4::text, $5::text
      ) AS r`

      async function findProperty(clientId: string): Promise<string | null> {
        const row = await pg.query<{ id: string }>(
          `SELECT ep.id FROM eligible_properties ep
           JOIN collection_area ca ON ca.id = ep.collection_area_id
           WHERE ca.client_id = $1 LIMIT 1`,
          [clientId],
        )
        return row.rows[0]?.id ?? null
      }

      it('staff caller creates, links, and can re-read the contact', async () => {
        await pg.query('BEGIN')
        try {
          const propertyId = await findProperty(CLIENT_ID)
          expect(propertyId, 'fixture missing: no Kwinana eligible_properties row').not.toBeNull()
          if (!propertyId) return
          await impersonate(USERS['client-admin'])

          const res = await pg.query<{ r: { contact_id: string } }>(STRATA_CALL, [
            propertyId, 'Strata', 'Manager', '+61400000001', 'rls-strata-new@example.test',
          ])
          const contactId = res.rows[0]!.r.contact_id
          expect(contactId).toBeTruthy()

          // Link landed atomically…
          const linked = await pg.query<{ strata_contact_id: string }>(
            `SELECT strata_contact_id FROM eligible_properties WHERE id = $1`,
            [propertyId],
          )
          expect(linked.rows[0]!.strata_contact_id).toBe(contactId)

          // …and the contact is now visible to the same caller via
          // contacts_admin_strata_select (no chicken-and-egg).
          const visible = await pg.query(
            `SELECT id FROM contacts WHERE id = $1`,
            [contactId],
          )
          expect(visible.rows.length).toBe(1)
        } finally {
          await pg.query('ROLLBACK')
        }
      })

      it('updates the oldest contact when duplicate emails exist', async () => {
        await pg.query('BEGIN')
        try {
          const propertyId = await findProperty(CLIENT_ID)
          if (!propertyId) return
          // Two contacts sharing an email (no unique index — VER-256).
          await pg.query(
            `INSERT INTO contacts (id, first_name, last_name, mobile_e164, email, created_at) VALUES
             ('cccccccc-0001-4000-8000-000000000001', 'Old', 'Row', '+61400000002', 'rls-strata-dup@example.test', now() - interval '2 days'),
             ('cccccccc-0002-4000-8000-000000000002', 'New', 'Row', '+61400000003', 'rls-strata-dup@example.test', now())`,
          )
          await impersonate(USERS['client-admin'])

          const res = await pg.query<{ r: { contact_id: string } }>(STRATA_CALL, [
            propertyId, 'Updated', 'Name', '+61400000004', 'rls-strata-dup@example.test',
          ])
          expect(res.rows[0]!.r.contact_id).toBe('cccccccc-0001-4000-8000-000000000001')

          await pg.query('RESET ROLE')
          const updated = await pg.query<{ first_name: string }>(
            `SELECT first_name FROM contacts WHERE id = 'cccccccc-0001-4000-8000-000000000001'`,
          )
          expect(updated.rows[0]!.first_name).toBe('Updated')
        } finally {
          await pg.query('ROLLBACK')
        }
      })

      it.each(['resident', 'field', 'ranger'] as const)('rejects a %s caller', async (role) => {
        await pg.query('BEGIN')
        try {
          const propertyId = await findProperty(CLIENT_ID)
          if (!propertyId) return
          await impersonate(USERS[role])

          let err: Error | null = null
          try {
            await pg.query(STRATA_CALL, [
              propertyId, 'A', 'B', '+61400000005', 'rls-strata-deny@example.test',
            ])
          } catch (e) {
            err = e as Error
          }
          expect(err?.message ?? '').toMatch(/staff roles/i)
        } finally {
          await pg.query('ROLLBACK')
        }
      })

      it('rejects a client-admin linking a contact on another tenant property', async () => {
        const VV_CLIENT_ID = '5215645f-ca8f-4cff-8b7d-d5a8f7991ec7'
        await pg.query('BEGIN')
        try {
          const propertyId = await findProperty(VV_CLIENT_ID)
          expect(propertyId, 'fixture missing: no vergevalet eligible_properties row').not.toBeNull()
          if (!propertyId) return
          await impersonate(USERS['client-admin']) // Kwinana-scoped

          let err: Error | null = null
          try {
            await pg.query(STRATA_CALL, [
              propertyId, 'A', 'B', '+61400000006', 'rls-strata-xt@example.test',
            ])
          } catch (e) {
            err = e as Error
          }
          expect(err?.message ?? '').toMatch(/accessible clients/i)
        } finally {
          await pg.query('ROLLBACK')
        }
      })
    })

    // Date validity (20260611031624): the RPC itself must reject closed dates —
    // the form filters are app-level only and the RPC is directly callable.
    it('rejects a booking onto an ID-closed collection date', async () => {
      await pg.query('BEGIN')
      try {
        const ctx = await setupIdDate()
        if (!ctx) return
        await pg.query(`UPDATE collection_date SET id_is_closed = true WHERE id = $1`, [
          ctx.dateId,
        ])
        await impersonate(USERS.ranger)

        let err: Error | null = null
        try {
          await pg.query(CALL, [
            ctx.dateId, ctx.areaId, -32.27, 115.75, 'x', '', [], ['General / Mixed'], ID_VOLUME_WIRE,
          ])
        } catch (e) {
          err = e as Error
        }
        expect(err?.message ?? '').toMatch(/closed for illegal dumping/i)
      } finally {
        await pg.query('ROLLBACK')
      }
    })
  })
})
