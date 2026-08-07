# Monthly Client Reports (PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contractor-admin-only downloadable PDF per client per month backing the monthly invoice — Kwinana by area, WMRC by sub-client, included vs extras segregated.

**Architecture:** One SECURITY DEFINER RPC (`get_client_monthly_report`) returns long-format rows; a pure TS module (`report-model.ts`) pivots them into two tables; a Next.js route handler renders the approved template with `@react-pdf/renderer` and streams the file; a card on `/admin/reports` (contractor-admin only) is the entry point. Spec: `docs/superpowers/specs/2026-08-06-monthly-client-reports-design.md`; visual reference: the two template HTML files beside it.

**Tech Stack:** Postgres (plpgsql RPC), Next.js 16 route handler, `@react-pdf/renderer`, Vitest.

**Release constraint (§21 ghost-release / Types Freshness):** Task 1 (migration) is **PR-A** on its own branch → merge to develop → Dan cuts a develop→main release → THEN regen types and build Tasks 2+ as **PR-B** (this branch). Never combine RPC + consumer in one PR.

---

### Task 1 (PR-A): Migration — `client.legal_name` + `get_client_monthly_report` RPC

**Files:**
- Create: `supabase/migrations/<version>_client_monthly_report_rpc.sql` (generate version via `pnpm supabase migration new client_monthly_report_rpc`; verify the 14-digit prefix is NOT already applied to prod — §21)

- [ ] **Step 1: Create the migration file**

Run: `pnpm supabase migration new client_monthly_report_rpc`

Write this content (guard idiom mirrors `get_mattress_daily` in `20260801040000_mattress_count_reporting.sql`, but contractor-admin only per spec):

```sql
-- Monthly client reports (invoice-backing PDF) — spec
-- docs/superpowers/specs/2026-08-06-monthly-client-reports-design.md
--
-- * client.legal_name — invoice counterparty name for the report footer.
--   client.name is the BRAND ("Verge Valet"); the counterparty is the
--   council ("Western Metropolitan Regional Council"). Nullable; consumers
--   fall back to name.
-- * get_client_monthly_report — long-format completed-collection counts for
--   one client + calendar month. Contractor-admin ONLY (this is the
--   operator's invoicing document, not a council-facing card — unlike
--   get_reports_monthly/get_mattress_daily which admit client-tier roles).
--   Two sources:
--     booked        booking_item units (actuals ?? booked) on Completed
--                   bookings, bucketed by the ITEM's collection date.
--     stop_mattress crew-logged collection_stop.mattress_count (VV-style
--                   tenants where client.mattress_closeout_stream is set),
--                   bucketed by the stop's as-dispatched date (§21: admin
--                   date corrections move the booking_item, never the stop).
--   Grouping is derived: client has sub_client rows -> group by sub-client,
--   else by collection area.

ALTER TABLE public.client
  ADD COLUMN IF NOT EXISTS legal_name text;

COMMENT ON COLUMN public.client.legal_name IS
  'Formal invoice-counterparty name for client-facing documents (monthly report footer). NULL = fall back to name.';

-- Slug-keyed backfill; no-ops on a fresh db reset (clients not migration-seeded).
UPDATE public.client SET legal_name = 'City of Kwinana'
 WHERE slug = 'kwn' AND legal_name IS NULL;
UPDATE public.client SET legal_name = 'Western Metropolitan Regional Council'
 WHERE slug = 'vergevalet' AND legal_name IS NULL;

CREATE OR REPLACE FUNCTION public.get_client_monthly_report(
  p_client_id uuid,
  p_month     date
)
 RETURNS TABLE(
   source       text,
   group_key    uuid,
   group_label  text,
   service_name text,
   waste_stream public.waste_stream,
   is_mattress  boolean,
   is_extra     boolean,
   units        bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_from   date := date_trunc('month', p_month)::date;
  v_to     date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_by_sub boolean;
BEGIN
  -- NULL-safe contractor-admin gate + tenant gate (§21: role gate alone is
  -- not enough; accessible_client_ids alone is not enough).
  IF (current_user_role() = 'contractor-admin') IS NOT TRUE
     OR (p_client_id IN (SELECT accessible_client_ids())) IS NOT TRUE THEN
    RETURN;
  END IF;

  v_by_sub := EXISTS (SELECT 1 FROM sub_client sc WHERE sc.client_id = p_client_id);

  RETURN QUERY
  SELECT 'booked'::text,
         CASE WHEN v_by_sub THEN sc.id ELSE ca.id END,
         CASE WHEN v_by_sub THEN coalesce(sc.name, 'Unassigned') ELSE ca.name END,
         s.name, s.waste_stream, s.is_mattress, bi.is_extra,
         sum(coalesce(bi.actual_services, bi.no_services))::bigint
    FROM booking_item bi
    JOIN booking b            ON b.id  = bi.booking_id
    JOIN collection_area ca   ON ca.id = b.collection_area_id
    LEFT JOIN sub_client sc   ON sc.id = ca.sub_client_id
    JOIN service s            ON s.id  = bi.service_id
    JOIN collection_date cd   ON cd.id = bi.collection_date_id
   WHERE b.client_id = p_client_id
     AND b.deleted_at IS NULL
     AND b.status = 'Completed'::booking_status
     AND cd.date >= v_from AND cd.date < v_to
   GROUP BY 2, 3, s.name, s.waste_stream, s.is_mattress, bi.is_extra

  UNION ALL
  SELECT 'stop_mattress'::text,
         CASE WHEN v_by_sub THEN sc.id ELSE ca.id END,
         CASE WHEN v_by_sub THEN coalesce(sc.name, 'Unassigned') ELSE ca.name END,
         'Mattress'::text, c.mattress_closeout_stream, true, false,
         sum(cs.mattress_count)::bigint
    FROM collection_stop cs
    JOIN client c             ON c.id  = cs.client_id
    JOIN booking b            ON b.id  = cs.booking_id
    JOIN collection_area ca   ON ca.id = b.collection_area_id
    LEFT JOIN sub_client sc   ON sc.id = ca.sub_client_id
    JOIN collection_date cd   ON cd.id = cs.collection_date_id
   WHERE cs.client_id = p_client_id
     AND c.mattress_closeout_stream IS NOT NULL
     AND cs.mattress_count IS NOT NULL
     AND b.deleted_at IS NULL
     AND b.status = 'Completed'::booking_status
     AND cd.date >= v_from AND cd.date < v_to
   GROUP BY 2, 3, c.mattress_closeout_stream;
END;
$function$;

-- Postgres grants EXECUTE to PUBLIC on creation (§21): staff-only DEFINER
-- RPCs must revoke anon/PUBLIC. authenticated keeps EXECUTE; the in-function
-- gate does the real filtering.
REVOKE EXECUTE ON FUNCTION public.get_client_monthly_report(uuid, date) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_client_monthly_report(uuid, date) TO authenticated, service_role;
```

- [ ] **Step 2: Check the version prefix is unused on prod**

Run: `ls supabase/migrations | cut -c1-14 | sort | uniq -d`
Expected: no output (no duplicate prefixes).

- [ ] **Step 3: Commit on a fresh PR-A branch off origin/develop**

```bash
git fetch origin && git checkout -b feature/client-monthly-report-rpc origin/develop
# (move the migration file over if it was created on the plan branch)
git add supabase/migrations/*_client_monthly_report_rpc.sql
git commit -m "feat: get_client_monthly_report RPC + client.legal_name (PR-A)"
git push -u origin feature/client-monthly-report-rpc
gh pr create --base develop --title "feat: monthly client report RPC + client.legal_name (PR-A)" --body "..."
```

PR body one-line why: "Gives each council a defensible, crew-confirmed quantity record backing the monthly invoice — protects real money on both sides of the bill. PR-A of two (Types Freshness split); consumer follows after release."

- [ ] **Step 4: After the develop→main release lands, verify on prod (rolled back)**

Run via `pnpm supabase db query --linked` (pattern: memory `prod-rolledback-rpc-verification`):

```sql
BEGIN;
DO $$
DECLARE n int;
BEGIN
  -- anon caller must get zero rows
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SELECT count(*) INTO n FROM public.get_client_monthly_report(
    (SELECT id FROM client WHERE slug='kwn'), '2026-07-01');
  IF n <> 0 THEN RAISE EXCEPTION 'anon leak: % rows', n; END IF;
  RAISE NOTICE 'gate ok';
END $$;
ROLLBACK;
```

Then as the real contractor-admin path can only be exercised from the app; the July totals to reconcile against (from the drafts, pulled 06/08): KWN included = 1,272 / extras = 6; VV included = 429 / extras = 0.

---

### Task 2 (PR-B): Regenerate types after PR-A releases

**Files:**
- Modify: `src/lib/supabase/types.ts` (generated)
- Modify: `supabase/functions/_shared/database.types.ts` (generated mirror)

- [ ] **Step 1: Regenerate with the LOCKFILE-PINNED CLI** (§21 — never the global CLI)

```bash
pnpm supabase gen types typescript --project-id tfddjmplcizfirxqhotv > src/lib/supabase/types.ts
bash scripts/sync-mirrors.sh
```

- [ ] **Step 2: Verify the delta is ONLY the new RPC + legal_name**

Run: `git diff --stat src/lib/supabase/types.ts` and skim the diff. Expected: `get_client_monthly_report` in Functions, `legal_name` on client Row/Insert/Update. Any dropped schema blocks (e.g. `graphql_public`) = wrong CLI version; redo Step 1.

- [ ] **Step 3: Commit**

```bash
git add src/lib/supabase/types.ts supabase/functions/_shared/database.types.ts
git commit -m "chore: regen types for get_client_monthly_report + client.legal_name"
```

---

### Task 3 (PR-B): Report model — pure pivot logic (TDD)

**Files:**
- Create: `src/lib/reports/client-monthly/report-model.ts`
- Test: `src/__tests__/reports/client-monthly-report-model.test.ts`

The one non-obvious rule set, all encoded here (spec §What + §Template):
- Column order: category `bulk` services first, then `anc` alphabetical, then Illegal Dumping last. Columns = union of services observed in rows ∪ services offered via service_rules; plus a synthetic Mattress column when `mattressCloseoutStream` is set.
- Mattress em-dash: when `mattressCloseoutStream` is set and ZERO `stop_mattress` rows exist for the month, every mattress cell (incl. total row) is `null` (renders —). If ANY exist, missing groups get 0.
- Extras table: `is_extra` rows only; columns = offered services (+ synthetic Mattress for closeout-stream tenants); Illegal Dumping never appears.
- Group label: by-area labels shorten `"Kwinana Area 1"` → `"Area 1"` via the `/\b(Area \d+)$/` capture, falling back to the full name; by-sub-client labels pass through.
- Included table = `is_extra=false` booked rows + `stop_mattress` rows.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/reports/client-monthly-report-model.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildClientMonthlyReport,
  shortenAreaLabel,
  type ReportRow,
  type OfferedService,
} from '@/lib/reports/client-monthly/report-model'

const KWN_OFFERED: OfferedService[] = [
  { name: 'Bulk Waste', category: 'bulk' },
  { name: 'Green Waste', category: 'bulk' },
  { name: 'E-Waste', category: 'anc' },
  { name: 'Mattress', category: 'anc' },
  { name: 'Whitegoods', category: 'anc' },
]

const booked = (over: Partial<ReportRow>): ReportRow => ({
  source: 'booked', group_key: 'g1', group_label: 'Kwinana Area 1',
  service_name: 'Bulk Waste', is_mattress: false, is_extra: false, units: 1,
  ...over,
})

describe('shortenAreaLabel', () => {
  it('shortens "Kwinana Area 1" to "Area 1"', () => {
    expect(shortenAreaLabel('Kwinana Area 1')).toBe('Area 1')
  })
  it('falls back to the full name when no Area-N suffix', () => {
    expect(shortenAreaLabel('Town Centre North')).toBe('Town Centre North')
  })
})

describe('buildClientMonthlyReport', () => {
  it('pivots included rows with row and column totals', () => {
    const rows: ReportRow[] = [
      booked({ units: 130 }),
      booked({ service_name: 'Green Waste', units: 105 }),
      booked({ group_key: 'g2', group_label: 'Kwinana Area 2', units: 152 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.groups.map((g) => g.label)).toEqual(['Area 1', 'Area 2'])
    const a1 = r.included.groups[0]!
    expect(a1.cells[0]).toBe(130)   // Bulk Waste
    expect(a1.cells[1]).toBe(105)   // Green Waste
    expect(a1.total).toBe(235)
    expect(r.included.totals.cells[0]).toBe(282)
    expect(r.included.totals.total).toBe(387)
  })

  it('orders columns bulk-category first, then ancillary alphabetical, ID last', () => {
    const rows: ReportRow[] = [
      booked({ service_name: 'Illegal Dumping', units: 1 }),
      booked({ service_name: 'Whitegoods', units: 2 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.columns).toEqual([
      'Bulk Waste', 'Green Waste', 'E-Waste', 'Mattress', 'Whitegoods', 'Illegal Dumping',
    ])
  })

  it('splits extras into their own table and never gives extras an ID column', () => {
    const rows: ReportRow[] = [
      booked({ units: 10 }),
      booked({ is_extra: true, units: 1 }),
      booked({ service_name: 'Illegal Dumping', units: 3 }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.included.totals.total).toBe(13)
    expect(r.extras.totals.total).toBe(1)
    expect(r.extras.columns).not.toContain('Illegal Dumping')
  })

  it('renders em-dash (null) mattress cells when closeout stream set but no stop data', () => {
    const rows: ReportRow[] = [booked({ group_label: 'Town of Cottesloe', units: 114 })]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }, { name: 'Green Waste', category: 'bulk' }],
      grouping: 'sub_client', mattressCloseoutStream: 'general',
    })
    const mi = r.included.columns.indexOf('Mattress')
    expect(mi).toBeGreaterThan(-1)
    expect(r.included.groups[0]!.cells[mi]).toBeNull()
    expect(r.included.totals.cells[mi]).toBeNull()
    // null cells don't poison row totals
    expect(r.included.groups[0]!.total).toBe(114)
  })

  it('uses real numbers (0 for missing groups) once any stop_mattress data exists', () => {
    const rows: ReportRow[] = [
      booked({ group_key: 'c1', group_label: 'Town of Cottesloe', units: 114 }),
      booked({ group_key: 'c2', group_label: 'Town of Mosman Park', units: 151 }),
      { source: 'stop_mattress', group_key: 'c1', group_label: 'Town of Cottesloe',
        service_name: 'Mattress', is_mattress: true, is_extra: false, units: 4 },
    ]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'sub_client', mattressCloseoutStream: 'general',
    })
    const mi = r.included.columns.indexOf('Mattress')
    expect(r.included.groups.find((g) => g.label === 'Town of Cottesloe')!.cells[mi]).toBe(4)
    expect(r.included.groups.find((g) => g.label === 'Town of Mosman Park')!.cells[mi]).toBe(0)
    expect(r.included.totals.cells[mi]).toBe(4)
  })

  it('a zero-extras month still renders the full extras table structure', () => {
    const rows: ReportRow[] = [booked({ units: 10 })]
    const r = buildClientMonthlyReport({
      rows, offered: KWN_OFFERED, grouping: 'area', mattressCloseoutStream: null,
    })
    expect(r.extras.columns.length).toBeGreaterThan(0)
    expect(r.extras.groups.map((g) => g.total)).toEqual([0])
    expect(r.extras.totals.total).toBe(0)
  })

  it('sorts groups alphabetically by label', () => {
    const rows: ReportRow[] = [
      booked({ group_key: 'm', group_label: 'Town of Mosman Park' }),
      booked({ group_key: 'p', group_label: 'Shire of Peppermint Grove' }),
    ]
    const r = buildClientMonthlyReport({
      rows, offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'sub_client', mattressCloseoutStream: null,
    })
    expect(r.included.groups.map((g) => g.label)).toEqual([
      'Shire of Peppermint Grove', 'Town of Mosman Park',
    ])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/__tests__/reports/client-monthly-report-model.test.ts`
Expected: FAIL — module `@/lib/reports/client-monthly/report-model` not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/reports/client-monthly/report-model.ts
/**
 * Pure pivot logic for the monthly client report PDF (invoice-backing).
 * Spec: docs/superpowers/specs/2026-08-06-monthly-client-reports-design.md
 * No Supabase, no wall clock — deterministic and fully unit-tested (money-
 * adjacent: these numbers back the council invoice).
 */

export interface ReportRow {
  source: 'booked' | 'stop_mattress'
  group_key: string
  group_label: string
  service_name: string
  is_mattress: boolean
  is_extra: boolean
  units: number
}

export interface OfferedService {
  name: string
  category: 'bulk' | 'anc' | 'id'
}

export interface ReportGroupRow {
  label: string
  /** One entry per column; null = no data (render em-dash), never fake 0. */
  cells: (number | null)[]
  total: number
}

export interface ReportTable {
  columns: string[]
  groups: ReportGroupRow[]
  totals: ReportGroupRow
}

export interface ClientMonthlyReport {
  included: ReportTable
  extras: ReportTable
}

export interface BuildOptions {
  rows: ReportRow[]
  offered: OfferedService[]
  grouping: 'area' | 'sub_client'
  mattressCloseoutStream: string | null
}

const ID_NAME = 'Illegal Dumping'
const MATTRESS_NAME = 'Mattress'

/** "Kwinana Area 1" -> "Area 1"; anything without an Area-N suffix passes through. */
export function shortenAreaLabel(name: string): string {
  const m = name.match(/\b(Area \d+)$/)
  return m?.[1] ?? name
}

/** bulk services first (stable), then ancillary alphabetical, ID always last. */
function orderColumns(names: string[], offered: OfferedService[]): string[] {
  const cat = new Map(offered.map((s) => [s.name, s.category]))
  const rank = (n: string) =>
    n === ID_NAME || cat.get(n) === 'id' ? 2 : cat.get(n) === 'anc' ? 1 : cat.get(n) === 'bulk' ? 0 : 1
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function pivot(
  columns: string[],
  groupLabels: Map<string, string>,
  cellValues: Map<string, Map<string, number>>, // group_key -> service -> units
  nullColumns: Set<string>
): ReportTable {
  const groups: ReportGroupRow[] = [...groupLabels.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([key, label]) => {
      const values = cellValues.get(key)
      const cells = columns.map((c) =>
        nullColumns.has(c) ? null : (values?.get(c) ?? 0)
      )
      return { label, cells, total: cells.reduce<number>((t, v) => t + (v ?? 0), 0) }
    })
  const totals: ReportGroupRow = {
    label: 'ALL',
    cells: columns.map((c, i) =>
      nullColumns.has(c) ? null : groups.reduce((t, g) => t + (g.cells[i] ?? 0), 0)
    ),
    total: groups.reduce((t, g) => t + g.total, 0),
  }
  return { columns, groups, totals }
}

export function buildClientMonthlyReport(opts: BuildOptions): ClientMonthlyReport {
  const { rows, offered, grouping, mattressCloseoutStream } = opts

  const labelOf = (raw: string) => (grouping === 'area' ? shortenAreaLabel(raw) : raw)

  const groupLabels = new Map<string, string>()
  for (const r of rows) groupLabels.set(r.group_key, labelOf(r.group_label))

  const stopRows = rows.filter((r) => r.source === 'stop_mattress')
  const hasStopData = stopRows.length > 0
  const mattressExpected = mattressCloseoutStream != null

  // ---- included ----
  const includedCells = new Map<string, Map<string, number>>()
  const add = (map: Map<string, Map<string, number>>, key: string, svc: string, units: number) => {
    const inner = map.get(key) ?? new Map<string, number>()
    inner.set(svc, (inner.get(svc) ?? 0) + units)
    map.set(key, inner)
  }
  for (const r of rows) {
    if (r.source === 'booked' && !r.is_extra) add(includedCells, r.group_key, r.service_name, r.units)
    if (r.source === 'stop_mattress') add(includedCells, r.group_key, MATTRESS_NAME, r.units)
  }
  const includedNames = new Set<string>(offered.map((s) => s.name))
  for (const r of rows) if (!r.is_extra) includedNames.add(r.service_name)
  if (mattressExpected) includedNames.add(MATTRESS_NAME)
  const includedNull = new Set<string>(
    mattressExpected && !hasStopData ? [MATTRESS_NAME] : []
  )
  const included = pivot(
    orderColumns([...includedNames], offered), groupLabels, includedCells, includedNull
  )

  // ---- extras (resident-paid; ID is never a resident-paid service) ----
  const extrasCells = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (r.source === 'booked' && r.is_extra) add(extrasCells, r.group_key, r.service_name, r.units)
  }
  const extrasNames = new Set<string>(
    offered.filter((s) => s.category !== 'id').map((s) => s.name)
  )
  for (const r of rows) if (r.is_extra) extrasNames.add(r.service_name)
  if (mattressExpected) extrasNames.add(MATTRESS_NAME)
  extrasNames.delete(ID_NAME)
  const extras = pivot(
    orderColumns([...extrasNames], offered), groupLabels, extrasCells, new Set()
  )

  return { included, extras }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/__tests__/reports/client-monthly-report-model.test.ts`
Expected: PASS (all 8).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reports/client-monthly/report-model.ts src/__tests__/reports/client-monthly-report-model.test.ts
git commit -m "feat: client monthly report pivot model (tested)"
```

---

### Task 4 (PR-B): Fonts + react-pdf dependency

**Files:**
- Create: `public/report-fonts/Poppins-SemiBold.ttf`, `public/report-fonts/Poppins-Bold.ttf`, `public/report-fonts/DMSans-Regular.ttf`, `public/report-fonts/DMSans-Medium.ttf`, `public/report-fonts/DMSans-Bold.ttf`
- Modify: `package.json` (dependency)

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @react-pdf/renderer`

- [ ] **Step 2: Download TTFs** (react-pdf accepts ttf/otf only — no woff)

```bash
mkdir -p public/report-fonts /tmp/rf && cd /tmp/rf
curl -sL -o poppins.zip "https://gwfh.mranftl.com/api/fonts/poppins?download=zip&subsets=latin&variants=600,700&formats=ttf"
curl -sL -o dmsans.zip  "https://gwfh.mranftl.com/api/fonts/dm-sans?download=zip&subsets=latin&variants=regular,500,700&formats=ttf"
unzip -o poppins.zip && unzip -o dmsans.zip && ls *.ttf
```

Copy into the repo with the exact names above (rename gwfh's output; e.g. `poppins-v23-latin-600.ttf` → `Poppins-SemiBold.ttf`, `dm-sans-v16-latin-regular.ttf` → `DMSans-Regular.ttf`, `-500` → `DMSans-Medium.ttf`). If gwfh is down, fall back to Google Fonts' GitHub (`github.com/google/fonts/tree/main/ofl/poppins`) — any source is fine as long as `file` reports TrueType.

- [ ] **Step 3: Verify they are real TTFs**

Run: `file public/report-fonts/*.ttf`
Expected: every line says `TrueType Font data`.

- [ ] **Step 4: Confirm the Docker image ships `public/`**

Run: `rg -n "public" Dockerfile`
Expected: a `COPY` line including `public` (Next standalone images copy it for static assets — the PDF route reads the TTFs from `process.cwd()/public/report-fonts` at runtime). If absent, add `COPY --from=builder /app/public ./public` alongside the existing standalone COPY lines.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml public/report-fonts
git commit -m "feat: react-pdf dependency + report fonts (Poppins/DM Sans TTFs)"
```

---

### Task 5 (PR-B): D&M logo as react-pdf SVG component

**Files:**
- Create: `src/lib/reports/client-monthly/dm-logo.tsx`

react-pdf's `<Image>` cannot rasterise SVG; its own `<Svg>/<Path>` primitives can draw it natively. The all-white D&M mark is 4 paths + 1 circle — copy the `d` attributes verbatim from `~/obsidian/Claude/wiki/dmwaste/design-system/logo/dm-logo-all-white.svg` (they are also embedded base64 in `docs/superpowers/specs/2026-08-06-monthly-client-report-template.html` — decode that if the vault file is unavailable).

- [ ] **Step 1: Write the component**

```tsx
// src/lib/reports/client-monthly/dm-logo.tsx
import { Svg, Path, Circle } from '@react-pdf/renderer'

/**
 * D&M Waste Management mark, all-white (sits on the client primary-colour
 * band). Path data transcribed from the brand asset
 * dm-logo-all-white.svg (viewBox 0 0 772.5 238.8).
 */
export function DmLogo({ width }: { width: number }) {
  const height = width * (238.8 / 772.5)
  return (
    <Svg width={width} height={height} viewBox="0 0 772.5 238.8">
      {/* paste the four <Path fill="#FFFFFF" d="..." /> elements and the
          <Circle fill="#FFFFFF" cx="52" cy="49.9" r="34.7" /> exactly as in
          the source SVG — do not re-draw or approximate the path data */}
    </Svg>
  )
}
```

(The implementer pastes the literal `d` strings — they are long; correctness = byte-identical to the asset.)

- [ ] **Step 2: Commit**

```bash
git add src/lib/reports/client-monthly/dm-logo.tsx
git commit -m "feat: D&M logo as react-pdf SVG component"
```

---

### Task 6 (PR-B): PDF document component (TDD smoke)

**Files:**
- Create: `src/lib/reports/client-monthly/pdf.tsx`
- Test: `src/__tests__/reports/client-monthly-pdf.test.ts`

Layout = the approved templates (`docs/superpowers/specs/2026-08-06-monthly-client-report-template*.html`): A4 landscape, brand band (primary colour, DmLogo, "Monthly Collections Statement", `service_name` subtitle, month + `REF-YYYY-MM` + issued date), "Included Collections" pill (primary), tenant-named extras pill (accent), the two pivot tables, footer strip "Prepared for the {legal_name ?? name} by D&M Waste Management" + "Page 1 of 1".

- [ ] **Step 1: Write the failing smoke test**

```typescript
// src/__tests__/reports/client-monthly-pdf.test.ts
import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { ClientMonthlyReportPdf } from '@/lib/reports/client-monthly/pdf'
import { buildClientMonthlyReport } from '@/lib/reports/client-monthly/report-model'

describe('ClientMonthlyReportPdf', () => {
  it('renders a valid single-page PDF from real-shaped data', async () => {
    const report = buildClientMonthlyReport({
      rows: [
        { source: 'booked', group_key: 'g1', group_label: 'Kwinana Area 1',
          service_name: 'Bulk Waste', is_mattress: false, is_extra: false, units: 130 },
        { source: 'booked', group_key: 'g1', group_label: 'Kwinana Area 1',
          service_name: 'Bulk Waste', is_mattress: false, is_extra: true, units: 1 },
      ],
      offered: [{ name: 'Bulk Waste', category: 'bulk' }],
      grouping: 'area',
      mattressCloseoutStream: null,
    })
    const buf = await renderToBuffer(
      ClientMonthlyReportPdf({
        report,
        monthLabel: 'July 2026',
        refCode: 'KWN-2026-07',
        issuedLabel: '06/08/2026',
        serviceName: 'VERCO Kwinana',
        legalName: 'City of Kwinana',
        extrasLabel: 'VERCO Extra',
        rowHeader: 'Collection Area',
        totalRowLabel: 'All Areas',
        primaryColour: '#0d295a',
        accentColour: '#69a24c',
      })
    )
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(10_000) // fonts embedded, not fallback
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run src/__tests__/reports/client-monthly-pdf.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```tsx
// src/lib/reports/client-monthly/pdf.tsx
import path from 'node:path'
import { Document, Page, View, Text, Font, StyleSheet } from '@react-pdf/renderer'
import { DmLogo } from './dm-logo'
import type { ClientMonthlyReport, ReportGroupRow } from './report-model'

const fontDir = path.join(process.cwd(), 'public', 'report-fonts')
Font.register({ family: 'Poppins', fonts: [
  { src: path.join(fontDir, 'Poppins-SemiBold.ttf'), fontWeight: 600 },
  { src: path.join(fontDir, 'Poppins-Bold.ttf'), fontWeight: 700 },
]})
Font.register({ family: 'DM Sans', fonts: [
  { src: path.join(fontDir, 'DMSans-Regular.ttf'), fontWeight: 400 },
  { src: path.join(fontDir, 'DMSans-Medium.ttf'), fontWeight: 500 },
  { src: path.join(fontDir, 'DMSans-Bold.ttf'), fontWeight: 700 },
]})

export interface PdfProps {
  report: ClientMonthlyReport
  monthLabel: string
  refCode: string
  issuedLabel: string
  serviceName: string
  legalName: string
  extrasLabel: string
  rowHeader: string
  totalRowLabel: string
  primaryColour: string
  accentColour: string
}

/** #rrggbb + alpha -> rgba() (tinted totals column / zebra rows). */
function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

const fmt = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-AU'))

// A4 landscape: 841.89 x 595.28 pt. Template mm -> pt at 2.835.
const s = StyleSheet.create({
  page: { fontFamily: 'DM Sans', fontSize: 9.5, color: '#1a1a1a', display: 'flex', flexDirection: 'column' },
  band: { color: '#ffffff', paddingVertical: 20, paddingHorizontal: 40, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  h1: { fontFamily: 'Poppins', fontWeight: 600, fontSize: 14.5 },
  sub: { fontSize: 9.5, opacity: 0.75, marginTop: 2 },
  month: { fontFamily: 'Poppins', fontWeight: 600, fontSize: 13, textAlign: 'right' },
  content: { paddingHorizontal: 40, paddingTop: 20, flexGrow: 1 },
  pill: { alignSelf: 'flex-start', color: '#ffffff', fontFamily: 'Poppins', fontWeight: 600, fontSize: 9, borderRadius: 4, paddingVertical: 4, paddingHorizontal: 11, marginBottom: 7 },
  row: { flexDirection: 'row' },
  th: { fontSize: 8, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.5, backgroundColor: '#f1f4f9', paddingVertical: 7, paddingHorizontal: 7, textAlign: 'right' },
  td: { paddingVertical: 6, paddingHorizontal: 7, textAlign: 'right', borderBottomWidth: 1, borderBottomColor: '#e8ecf2' },
  foot: { backgroundColor: '#f1f4f9', paddingVertical: 10, paddingHorizontal: 40, flexDirection: 'row', justifyContent: 'space-between', fontSize: 8, color: '#64748b' },
})

/** First column is wide (flex 2.2); numeric columns share evenly. */
function Table({ table, rowHeader, totalRowLabel, primary, accent }: {
  table: { columns: string[]; groups: ReportGroupRow[]; totals: ReportGroupRow }
  rowHeader: string
  totalRowLabel: string
  primary: string
  accent: string
}) {
  const totalsBg = tint(accent, 0.14)
  const Cell = ({ v, style }: { v: string; style?: object[] }) => (
    <Text style={[s.td, { flex: 1 }, ...(style ?? [])]}>{v}</Text>
  )
  return (
    <View>
      <View style={[s.row, { borderBottomWidth: 2, borderBottomColor: primary }]}>
        <Text style={[s.th, { flex: 2.2, textAlign: 'left' }]}>{rowHeader}</Text>
        {table.columns.map((c) => <Text key={c} style={[s.th, { flex: 1 }]}>{c}</Text>)}
        <Text style={[s.th, { flex: 1, backgroundColor: totalsBg }]}>Total</Text>
      </View>
      {table.groups.map((g, i) => (
        <View key={g.label} style={[s.row, i % 2 ? { backgroundColor: '#fafbfd' } : {}]}>
          <Cell v={g.label} style={[{ flex: 2.2, textAlign: 'left' }]} />
          {g.cells.map((v, j) => (
            <Cell key={j} v={fmt(v)} style={v === 0 || v == null ? [{ color: '#c2cad6' }] : []} />
          ))}
          <Cell v={fmt(g.total)} style={[{ backgroundColor: totalsBg, fontWeight: 700 }]} />
        </View>
      ))}
      <View style={[s.row, { backgroundColor: primary }]}>
        <Cell v={totalRowLabel} style={[{ flex: 2.2, textAlign: 'left', color: '#fff', fontWeight: 700, borderBottomWidth: 0 }]} />
        {table.totals.cells.map((v, j) => (
          <Cell key={j} v={fmt(v)} style={[{ color: '#fff', fontWeight: 700, borderBottomWidth: 0 }]} />
        ))}
        <Cell v={fmt(table.totals.total)} style={[{ backgroundColor: accent, color: '#fff', fontWeight: 700, fontSize: 10.5, borderBottomWidth: 0 }]} />
      </View>
    </View>
  )
}

export function ClientMonthlyReportPdf(p: PdfProps) {
  return (
    <Document title={`${p.legalName} — Monthly Collections Statement — ${p.monthLabel}`}>
      <Page size="A4" orientation="landscape" style={s.page}>
        <View style={[s.band, { backgroundColor: p.primaryColour }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}>
            <DmLogo width={120} />
            <View>
              <Text style={s.h1}>Monthly Collections Statement</Text>
              <Text style={s.sub}>{p.serviceName} · Bulk Verge Collection Service</Text>
            </View>
          </View>
          <View>
            <Text style={s.month}>{p.monthLabel}</Text>
            <Text style={[s.sub, { textAlign: 'right' }]}>Ref {p.refCode} · Issued {p.issuedLabel}</Text>
          </View>
        </View>
        <View style={s.content}>
          <Text style={[s.pill, { backgroundColor: p.primaryColour }]}>Included Collections</Text>
          <Table table={p.report.included} rowHeader={p.rowHeader} totalRowLabel={p.totalRowLabel}
                 primary={p.primaryColour} accent={p.accentColour} />
          <Text style={[s.pill, { backgroundColor: p.accentColour, marginTop: 17 }]}>{p.extrasLabel}</Text>
          <Table table={p.report.extras} rowHeader={p.rowHeader} totalRowLabel={p.totalRowLabel}
                 primary={p.primaryColour} accent={p.accentColour} />
        </View>
        <View style={s.foot}>
          <Text>Prepared for the <Text style={{ fontWeight: 700, color: p.primaryColour }}>{p.legalName}</Text> by <Text style={{ fontWeight: 700, color: p.primaryColour }}>D&M Waste Management</Text></Text>
          <Text>Page 1 of 1</Text>
        </View>
      </Page>
    </Document>
  )
}
```

- [ ] **Step 4: Run the smoke test** — `pnpm vitest run src/__tests__/reports/client-monthly-pdf.test.ts` → PASS.

- [ ] **Step 5: Eyeball it once** — add a throwaway script call (do not commit) `npx tsx -e "..."` writing the buffer to the scratchpad and open it; compare against `docs/superpowers/specs/2026-08-06-monthly-client-report-template.html`. Adjust pt values until it matches the approved look.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/client-monthly/pdf.tsx src/__tests__/reports/client-monthly-pdf.test.ts
git commit -m "feat: monthly client report PDF document (react-pdf)"
```

---

### Task 7 (PR-B): Route handler `GET /admin/reports/client-report/pdf`

**Files:**
- Create: `src/app/(admin)/admin/reports/client-report/pdf/route.ts`
- Test: `src/__tests__/reports/client-monthly-route-params.test.ts`

- [ ] **Step 1: Write the failing param-validation test**

```typescript
// src/__tests__/reports/client-monthly-route-params.test.ts
import { describe, it, expect } from 'vitest'
import { parseReportParams } from '@/app/(admin)/admin/reports/client-report/pdf/params'

describe('parseReportParams', () => {
  it('accepts a uuid client and YYYY-MM month', () => {
    const r = parseReportParams('123e4567-e89b-42d3-a456-426614174000', '2026-07')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.monthStart).toBe('2026-07-01')
  })
  it('rejects a malformed month', () => {
    expect(parseReportParams('123e4567-e89b-42d3-a456-426614174000', '2026-13').ok).toBe(false)
    expect(parseReportParams('123e4567-e89b-42d3-a456-426614174000', 'julY').ok).toBe(false)
  })
  it('rejects a non-uuid client', () => {
    expect(parseReportParams('kwn', '2026-07').ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**, then implement params + route.

```typescript
// src/app/(admin)/admin/reports/client-report/pdf/params.ts
import { z } from 'zod'
import type { Result } from '@/lib/shared/result' // reuse the repo Result<T,E>; if the
// canonical import differs, follow the existing pattern (rg "Result<" src/lib)

const schema = z.object({
  clientId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
})

export interface ReportParams {
  clientId: string
  month: string       // YYYY-MM
  monthStart: string  // YYYY-MM-01 (RPC arg)
}

export function parseReportParams(
  clientId: unknown, month: unknown
): Result<ReportParams> {
  const p = schema.safeParse({ clientId, month })
  if (!p.success) return { ok: false, error: 'Invalid client or month' }
  return { ok: true, data: { ...p.data, monthStart: `${p.data.month}-01` } }
}
```

```typescript
// src/app/(admin)/admin/reports/client-report/pdf/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { renderToBuffer } from '@react-pdf/renderer'
import { createClient } from '@/lib/supabase/server'
import { buildClientMonthlyReport, type ReportRow, type OfferedService }
  from '@/lib/reports/client-monthly/report-model'
import { ClientMonthlyReportPdf } from '@/lib/reports/client-monthly/pdf'
import { parseReportParams } from './params'

export async function GET(req: NextRequest) {
  const params = parseReportParams(
    req.nextUrl.searchParams.get('client'),
    req.nextUrl.searchParams.get('month')
  )
  if (!params.ok) return new NextResponse('Bad request', { status: 400 })
  const { clientId, month, monthStart } = params.data

  const supabase = await createClient()

  // Contractor-admin only (defence in depth: the RPC re-gates — §12).
  const { data: role } = await supabase.rpc('current_user_role')
  if (role !== 'contractor-admin') return new NextResponse('Forbidden', { status: 403 })

  // Tenant scope: NEVER validate against the public-SELECT client table alone
  // (§21 admin-switcher trap) — narrow through accessible_client_ids().
  const { data: accessibleIds } = await supabase.rpc('accessible_client_ids')
  if (!accessibleIds?.includes(clientId)) return new NextResponse('Forbidden', { status: 403 })

  const [{ data: client }, { data: rows, error: rpcError }, { data: subClients }, { data: ruleRows }] =
    await Promise.all([
      supabase.from('client')
        .select('slug, name, legal_name, service_name, primary_colour, accent_colour, mattress_closeout_stream')
        .eq('id', clientId).single(),
      supabase.rpc('get_client_monthly_report', { p_client_id: clientId, p_month: monthStart }),
      supabase.from('sub_client').select('id').eq('client_id', clientId).limit(1),
      supabase.from('service_rules')
        .select('service:service_id!inner(name, category:category_id!inner(code)), collection_area:collection_area_id!inner(client_id)')
        .eq('collection_area.client_id', clientId),
    ])
  if (!client) return new NextResponse('Not found', { status: 404 })
  if (rpcError) return new NextResponse(rpcError.message, { status: 500 })

  // NOTE: verify the embed hint names against types.ts at implementation time
  // (§21 multi-FK embed gotcha) — if the embed comes back empty for an authed
  // user, split into two queries and stitch (canonical: bookings-list-client).
  const offered: OfferedService[] = [
    ...new Map(
      (ruleRows ?? []).map((r) => [r.service.name, {
        name: r.service.name,
        category: r.service.category.code as OfferedService['category'],
      }])
    ).values(),
  ]

  const grouping = (subClients?.length ?? 0) > 0 ? 'sub_client' as const : 'area' as const
  const report = buildClientMonthlyReport({
    rows: (rows ?? []) as ReportRow[],
    offered,
    grouping,
    mattressCloseoutStream: client.mattress_closeout_stream,
  })

  const [y, m] = month.split('-') as [string, string]
  const monthLabel = new Date(Date.UTC(Number(y), Number(m) - 1, 1))
    .toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const issuedLabel = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Perth' })
  const isVergeValet = client.slug === 'vergevalet'

  const buf = await renderToBuffer(
    ClientMonthlyReportPdf({
      report,
      monthLabel,
      refCode: `${client.slug.toUpperCase()}-${month}`,
      issuedLabel,
      serviceName: client.service_name ?? client.name,
      legalName: client.legal_name ?? client.name,
      extrasLabel: isVergeValet ? 'Verge Valet Extra' : 'VERCO Extra',
      rowHeader: grouping === 'sub_client' ? 'Council' : 'Collection Area',
      totalRowLabel: grouping === 'sub_client' ? 'All Councils' : 'All Areas',
      primaryColour: client.primary_colour ?? '#293F52',
      accentColour: client.accent_colour ?? '#00E47C',
    })
  )

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${client.slug}-collections-${month}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
```

(`extrasLabel`: the spec says "derive from client branding". `service_name` starting with "VERCO" → "VERCO Extra", else `${service_name} Extra` is the generalisation — implement it that way rather than the slug ternary if trivial: `client.service_name?.startsWith('VERCO') ? 'VERCO Extra' : `${client.service_name ?? 'Verge Valet'} Extra``. Either satisfies today's two tenants; prefer the derivation.)

- [ ] **Step 3: Run tests** — `pnpm vitest run src/__tests__/reports/client-monthly-route-params.test.ts` → PASS. Also `pnpm tsc --noEmit` (or the repo's typecheck script) → clean; fix any embed-typing mismatches against the regenerated types.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(admin\)/admin/reports/client-report src/__tests__/reports/client-monthly-route-params.test.ts
git commit -m "feat: client monthly report PDF route (contractor-admin only)"
```

---

### Task 8 (PR-B): "Client reports" card on /admin/reports

**Files:**
- Create: `src/app/(admin)/admin/reports/client-reports-card.tsx`
- Modify: `src/app/(admin)/admin/reports/reports-client.tsx` (mount the card)

- [ ] **Step 1: Write the card** (client component — follows the admin design system §21: no inline hex, token type scale)

```tsx
// src/app/(admin)/admin/reports/client-reports-card.tsx
'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAccessibleClientOptions, type ClientOption } from '@/lib/admin/accessible-clients'

/** Last complete calendar month as YYYY-MM (a report for the running month
 *  would under-count, so default to the invoiceable one). */
export function lastCompleteMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function ClientReportsCard() {
  const [clients, setClients] = useState<ClientOption[]>([])
  const [clientId, setClientId] = useState('')
  const [month, setMonth] = useState(() => lastCompleteMonth(new Date()))

  useEffect(() => {
    const supabase = createClient()
    fetchAccessibleClientOptions(supabase).then((opts) => {
      setClients(opts)
      setClientId((cur) => cur || (opts[0]?.id ?? ''))
    })
  }, [])

  const href = clientId && month
    ? `/admin/reports/client-report/pdf?client=${clientId}&month=${month}`
    : undefined

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-caption uppercase text-gray-500">Client reports</h2>
      <p className="mt-1 text-sm text-gray-600">
        Monthly collections statement (PDF) — the quantity record backing the monthly invoice.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-xs text-gray-500">Client</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)}
                  className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm">
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-gray-500">Month</span>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
                 className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm" />
        </label>
        <a href={href} aria-disabled={!href}
           className="rounded bg-navy-800 px-3 py-2 text-sm text-white aria-disabled:opacity-50"
           download>
          Download PDF
        </a>
      </div>
    </section>
  )
}
```

(Match the exact card / button classes used by sibling cards in `reports-client.tsx` while implementing — compose `components/admin/` primitives where they fit rather than re-typing markup; the JSX above is the shape, not licence to diverge from the design system.)

- [ ] **Step 2: Mount it, contractor-admin ONLY**

In `reports-client.tsx`, next to the existing top-of-page sections, add:

```tsx
import { ClientReportsCard } from './client-reports-card'
// inside the render, near the top of the page body:
{viewerRole === 'contractor-admin' && <ClientReportsCard />}
```

Note: the card is stricter than the `lib/reports/audience.ts` contractor-only tier (which includes contractor-staff) — this is an explicit role check by design (spec: contractor-admin only). Do not add it to the audience map.

- [ ] **Step 3: Unit-test the month default**

Append to `src/__tests__/reports/client-monthly-route-params.test.ts`:

```typescript
import { lastCompleteMonth } from '@/app/(admin)/admin/reports/client-reports-card'

describe('lastCompleteMonth', () => {
  it('rolls back one month', () => {
    expect(lastCompleteMonth(new Date(2026, 7, 6))).toBe('2026-07')  // Aug 6 -> July
  })
  it('crosses the year boundary', () => {
    expect(lastCompleteMonth(new Date(2026, 0, 15))).toBe('2025-12') // Jan -> Dec
  })
})
```

Run: `pnpm vitest run src/__tests__/reports/client-monthly-route-params.test.ts` → PASS.

- [ ] **Step 4: Verify in the browser** (dev server): as a contractor-admin, `/admin/reports` shows the card; pick City of Kwinana + 2026-07 → downloads a PDF whose totals read 1,272 / 6; pick Verge Valet → 429 / 0 with an em-dash mattress column. As a client-admin login, the card is absent AND hitting the route URL directly returns 403.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(admin\)/admin/reports
git commit -m "feat: client reports card on /admin/reports (contractor-admin only)"
```

---

### Task 9 (PR-B): Full check, ship

- [ ] **Step 1: Full verification**

```bash
pnpm test && pnpm build
```

Expected: all green (E2E runs only on base==main PRs — skipped on develop PRs by design).

- [ ] **Step 2: PR**

```bash
git push -u origin claude/monthly-client-reports-3da2f3
gh pr create --base develop --title "feat: monthly client reports PDF (contractor-admin)" --body "..."
```

Body includes: the one-line why (invoice-backing quantity record — protects real money), spec + template links, screenshots of both July PDFs, note that PR-A (RPC) already released, and the VV-mattress-from-01/08 caveat.

- [ ] **Step 3: Post-release prod check**

After Dan cuts the develop→main release: `/api/health` SHA matches (ghost-release memory), then download both July reports on prod and reconcile totals (KWN 1,272/6 · VV 429/0).

---

## Self-review notes

- Spec coverage: counting rule (Task 1 SQL), grouping derivation (Task 1 + route), mattress dual-source + em-dash (Tasks 1/3), extras segregation + zero-month structure (Task 3), labels/branding/fonts/logo (Tasks 4–7), legal_name (Tasks 1/7), contractor-admin gate ×3 layers (Tasks 1/7/8), two-PR rollout (Task ordering), tests incl. role-gate prod verification (Tasks 1/3/6/7/8).
- Out of scope (per spec): comparisons, rates, email/cron, archive — nothing here builds them.
- Known judgement point for the implementer: exact PostgREST embed hint names in Task 7's `service_rules` query must be checked against the regenerated types (§21 embed gotcha) — fallback is split-query + stitch.
