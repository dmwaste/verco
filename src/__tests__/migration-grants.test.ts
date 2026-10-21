import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every new table or view in `public` ships its own GRANTs.
 *
 * Until 30/10/2026 Supabase granted anon, authenticated and service_role on
 * every new object in `public` through the schema's default privileges, so no
 * migration of ours ever wrote a GRANT. From that date it doesn't
 * (github.com/orgs/supabase/discussions/45329). A table created without one
 * exists, but every Data API caller gets 42501 "permission denied for table":
 * residents, staff, and the service-role Edge Functions too (BYPASSRLS skips
 * policies, not grants). The feature on top of it is dead on arrival.
 *
 * Tables already on prod keep their grants, so migrations up to LAST_EXEMPT are
 * exempt. `CREATE OR REPLACE VIEW` of a view an earlier migration made keeps its
 * grants too; only a brand-new relation needs them.
 */

const MIGRATIONS = join(__dirname, '../../supabase/migrations')

// The newest migration written before the rule. Every later file must comply.
const LAST_EXEMPT = '20261021023000'

const CREATE_RE =
  /\bcreate\s+(?:or\s+replace\s+)?(table|(?:materialized\s+)?view)\s+(?:if\s+not\s+exists\s+)?(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?/gi

/** SQL with comments blanked, so a commented-out CREATE or GRANT doesn't count. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** Tables and views a migration creates in `public`. */
function createdRelations(sql: string): Array<{ kind: 'table' | 'view'; name: string }> {
  return [...stripComments(sql).matchAll(CREATE_RE)]
    .filter((m) => !m[2] || m[2].toLowerCase() === 'public')
    .map((m) => ({
      kind: m[1]!.toLowerCase() === 'table' ? ('table' as const) : ('view' as const),
      name: m[3]!.toLowerCase(),
    }))
}

function grantsOn(sql: string, name: string): boolean {
  const re = new RegExp(
    `\\bgrant\\s[^;]*?\\bon\\s+(?:table\\s+|sequence\\s+)?(?:"?public"?\\.)?"?${name}"?\\b[^;]*?\\bto\\b`,
    'i',
  )
  return re.test(stripComments(sql))
}

// A serial or identity column (not a GENERATED ... STORED one) creates a sequence.
const SEQUENCE_COL_RE =
  /(?:^|[(,])\s*"?([a-z_][a-z0-9_]*)"?\s+(?:(?:big|small)?serial\b|[a-z0-9_ ]*?\bgenerated\s+(?:always|by\s+default)\s+as\s+identity\b)/gi

/** Sequences a migration's new public tables create: Postgres names them <table>_<column>_seq. */
function createdSequences(sql: string): string[] {
  return stripComments(sql)
    .split(';')
    .flatMap((stmt) =>
      createdRelations(stmt)
        .filter((r) => r.kind === 'table')
        .flatMap((r) => [...stmt.matchAll(SEQUENCE_COL_RE)].map((m) => `${r.name}_${m[1]!.toLowerCase()}_seq`)),
    )
}

/** Relations (and their sequences) this migration creates without granting on them. */
function missingGrants(sql: string, earlier: Set<string>): string[] {
  return [
    ...createdRelations(sql)
      .filter((r) => r.kind === 'table' || !earlier.has(r.name))
      .map((r) => r.name),
    ...createdSequences(sql),
  ].filter((name) => !grantsOn(sql, name))
}

describe('missingGrants', () => {
  it('flags a table with no GRANT', () => {
    expect(missingGrants('CREATE TABLE public.thing (id uuid);', new Set())).toEqual(['thing'])
  })

  it('accepts a table granted in the same migration', () => {
    const sql = `CREATE TABLE IF NOT EXISTS public."thing" (id uuid);
      GRANT SELECT, INSERT ON TABLE public.thing TO authenticated, service_role;`
    expect(missingGrants(sql, new Set())).toEqual([])
  })

  it('does not count a commented-out GRANT', () => {
    const sql = `CREATE TABLE thing (id uuid);
      -- GRANT SELECT ON public.thing TO authenticated;`
    expect(missingGrants(sql, new Set())).toEqual(['thing'])
  })

  it('flags the sequence of a serial or identity column granted only on the table', () => {
    const sql = `CREATE TABLE public.thing (id bigserial PRIMARY KEY, n bigint GENERATED ALWAYS AS IDENTITY);
      GRANT SELECT, INSERT ON public.thing TO authenticated;`
    expect(missingGrants(sql, new Set())).toEqual(['thing_id_seq', 'thing_n_seq'])
  })

  it('accepts sequences granted in the same migration, and ignores GENERATED ... STORED', () => {
    const sql = `CREATE TABLE public.thing (id serial, full_name text GENERATED ALWAYS AS (a || b) STORED);
      GRANT SELECT, INSERT ON public.thing TO authenticated;
      GRANT USAGE, SELECT ON SEQUENCE public.thing_id_seq TO authenticated, service_role;`
    expect(missingGrants(sql, new Set())).toEqual([])
  })

  it('does not take a grant on a longer name for this one', () => {
    const sql = `CREATE TABLE public.thing (id uuid);
      GRANT SELECT ON public.thing_log TO authenticated;`
    expect(missingGrants(sql, new Set())).toEqual(['thing'])
  })

  it('needs a grant for a new view, not for replacing an existing one', () => {
    const sql = 'CREATE OR REPLACE VIEW public.v_thing WITH (security_invoker = on) AS SELECT 1;'
    expect(missingGrants(sql, new Set())).toEqual(['v_thing'])
    expect(missingGrants(sql, new Set(['v_thing']))).toEqual([])
  })

  it('ignores schemas other than public, and temp tables', () => {
    const sql = `CREATE TABLE private.thing (id uuid);
      CREATE TEMP TABLE scratch (id uuid);`
    expect(missingGrants(sql, new Set())).toEqual([])
  })
})

describe('migrations after LAST_EXEMPT grant on what they create', () => {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  it('LAST_EXEMPT names a real migration', () => {
    expect(files.some((f) => f.startsWith(`${LAST_EXEMPT}_`))).toBe(true)
  })

  const earlier = new Set<string>()
  const offenders: string[] = []
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8')
    if (f.slice(0, 14) > LAST_EXEMPT) {
      for (const name of missingGrants(sql, earlier)) offenders.push(`${f}: public.${name}`)
    }
    for (const r of createdRelations(sql)) earlier.add(r.name)
  }

  it('every new table and view has a GRANT in the same migration', () => {
    expect(offenders, 'add GRANTs (see CLAUDE.md §21 DB objects)').toEqual([])
  })
})
