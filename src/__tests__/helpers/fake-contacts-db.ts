/**
 * In-memory stand-in for the Supabase query shapes the contact write paths issue:
 * find-by-email, booking / strata usage, update, insert. Filters apply in call
 * order; every write is recorded so a test can assert that a contact other
 * residents use was never updated (ADR 0027, #631).
 */
export type FakeRow = Record<string, unknown>

type FakeResult = { data: unknown; error: { message: string } | null }

interface FakeQuery extends PromiseLike<FakeResult> {
  select(...args: unknown[]): FakeQuery
  order(...args: unknown[]): FakeQuery
  ilike(col: string, pattern: string): FakeQuery
  eq(col: string, value: unknown): FakeQuery
  in(col: string, values: unknown[]): FakeQuery
  or(expr: string): FakeQuery
  limit(n: number): FakeQuery
  update(data: FakeRow): FakeQuery
  insert(data: FakeRow): FakeQuery
  single(): Promise<FakeResult>
  maybeSingle(): Promise<FakeResult>
}

export interface FakeContactsDb {
  client: { from(table: string): FakeQuery }
  updates: Array<{ id: unknown; data: FakeRow }>
  inserts: FakeRow[]
}

// PostgREST `ilike` pattern from emailMatchPattern(): `%`, `_` and `\` escaped.
const unescapeLike = (p: string) => p.replace(/\\(.)/g, '$1').toLowerCase()

// `a.is.null,b.neq.x` — the only `.or()` shapes the contact paths send.
function orMatches(row: FakeRow, expr: string): boolean {
  return expr.split(',').some((cond) => {
    const [col = '', op, ...rest] = cond.split('.')
    const value = rest.join('.')
    if (op === 'is' && value === 'null') return row[col] == null
    if (op === 'neq') return row[col] !== value
    if (op === 'eq') return row[col] === value
    return false
  })
}

export function fakeContactsDb(
  seed: { contacts?: FakeRow[]; booking?: FakeRow[]; eligible_properties?: FakeRow[] },
  opts: { failContactsLookup?: string } = {},
): FakeContactsDb {
  const tables: Record<string, FakeRow[]> = {
    contacts: seed.contacts ?? [],
    booking: seed.booking ?? [],
    eligible_properties: seed.eligible_properties ?? [],
  }
  const updates: FakeContactsDb['updates'] = []
  const inserts: FakeRow[] = []

  function from(table: string): FakeQuery {
    let rows = [...(tables[table] ?? [])]
    let write: { kind: 'update' | 'insert'; data: FakeRow } | null = null

    const run = (): FakeResult => {
      if (write?.kind === 'update') {
        for (const r of rows) updates.push({ id: r.id, data: write.data })
        return { data: null, error: null }
      }
      if (write?.kind === 'insert') {
        inserts.push(write.data)
        return { data: { id: `new-${inserts.length}` }, error: null }
      }
      if (table === 'contacts' && opts.failContactsLookup) {
        return { data: null, error: { message: opts.failContactsLookup } }
      }
      return { data: rows, error: null }
    }

    const q: FakeQuery = {
      select: () => q,
      order: () => q,
      ilike: (col, pattern) => {
        rows = rows.filter((r) => String(r[col] ?? '').toLowerCase() === unescapeLike(pattern))
        return q
      },
      eq: (col, value) => {
        rows = rows.filter((r) => r[col] === value)
        return q
      },
      in: (col, values) => {
        rows = rows.filter((r) => values.includes(r[col]))
        return q
      },
      or: (expr) => {
        rows = rows.filter((r) => orMatches(r, expr))
        return q
      },
      limit: (n) => {
        rows = rows.slice(0, n)
        return q
      },
      update: (data) => {
        write = { kind: 'update', data }
        return q
      },
      insert: (data) => {
        write = { kind: 'insert', data }
        return q
      },
      single: async () => run(),
      maybeSingle: async () => {
        const r = run()
        return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r
      },
      then: (onFulfilled, onRejected) => Promise.resolve(run()).then(onFulfilled, onRejected),
    }
    return q
  }

  return { client: { from }, updates, inserts }
}
