# Admin Design System

The `(admin)` surface (contractor + council staff console) is built from one small
set of tokens and shared components. This doc is what you read **before touching any
admin page** so pages stay uniform and you don't reintroduce the bugs the
2026-07 uniformity work removed (arbitrary pixel sizes, stock-colour status pills,
silently-dropped font sizes).

- **Reference** (below) — the tokens, the components, the status entities.
- **How-to** — build a list page, add a status pill, add a form, add a detail page.
- **Explanation** — why the system exists, the `cn()` gotcha, the size/colour decisions.

The one-line version lives in `CLAUDE.md` §21 ("Admin + white-label UI"). This is the
long version. Scope: admin only — public/field surfaces are white-labelled and use the
`--brand*` vars instead.

---

## Reference

### Type scale (tokens)

Defined in `src/app/globals.css` `@theme`. **Never use an arbitrary `text-[Npx]` on an
admin surface** — every size has a token or a Tailwind built-in.

| Token | px | Use |
|---|---|---|
| `text-2xs` | 10 | tiny chips / badges only |
| `text-caption` | 11 | badge pills, table header cells, timestamps, **uppercase section labels** |
| `text-xs` | 12 | Tailwind built-in — the 12px size (no custom token) |
| `text-body-sm` | 13 | descriptions, secondary text, table cells, form inputs |
| `text-sm` | 14 | Tailwind built-in — the 14px size (no custom token) |
| `text-body` | 15 | buttons, inputs, primary body |
| `text-subtitle` | 17 | card headings |
| `text-xl` | 20 | **admin page titles** (via `PageHeader`) |
| `text-title` | 22 | modal / hero headings (NOT admin page titles) |
| `text-display` | 28 | large section headings; dashboard stat numbers |

Two rules that come up constantly:
- **12px is `text-xs`, 14px is `text-sm`** — there is deliberately no custom token for
  those two (decision D1). Do not write `text-[12px]` / `text-[14px]`.
- **Uppercase section labels are `text-caption` (11px)**, matching `Th`. `text-2xs` (10px)
  is reserved for genuinely tiny chips (decision D2).

> Adding a new `--text-*` token? It must go in **both** `globals.css` AND `src/lib/utils.ts`
> (see the `cn()` explanation below), or it silently renders at the wrong size. The test
> `src/__tests__/cn-custom-font-sizes.test.ts` derives its token list from `globals.css`, so
> a token you forget to register in `utils.ts` fails CI.

### Status colours (tokens)

The only status colours in the app. Also in `globals.css` `@theme`, consumed as
`bg-status-*-bg` + `text-status-*` pairs. **Never** introduce a stock Tailwind status
colour (`bg-amber-50`, `text-red-700`, …) or a raw hex for status meaning.

| Meaning | bg utility | text utility | hex |
|---|---|---|---|
| success | `bg-status-success-bg` | `text-status-success` | `#E8FDF0` / `#006A38` |
| warn | `bg-status-warn-bg` | `text-status-warn` | `#FFF3EA` / `#8B4000` |
| error | `bg-status-error-bg` | `text-status-error` | `#FFF0F0` / `#E53E3E` |
| info | `bg-status-info-bg` | `text-status-info` | `#EBF5FF` / `#3182CE` |

Two non-semantic literal pairs also exist (a purple accent for "parked with us" states,
a navy tint for contractor role badges) — see `PURPLE` / `NAVY` in `status-styles.ts`.
They are the only allowed literal colour pairs; both are exposed through the components
below (`Pill tone="accent"`, `role` entity), so you never hand-type the hex.

### Keyboard focus

The `(admin)` layout root carries an `admin-surface` class. A base rule in `globals.css`
gives every focusable element a visible ring:

```css
.admin-surface :focus-visible { outline: 2px solid #293F52; outline-offset: 2px; }
```

If you must use `outline-none` on an input, pair it with an explicit affordance
(`focus:border-[#293F52]` or a `focus-within` border on the wrapper) — the shared form
and filter components already do this.

### Components (`src/components/admin/` + `src/components/status-badge.tsx`)

| Component | Import | What it is |
|---|---|---|
| `PageHeader` | `@/components/admin/page-header` | List-page header: title + optional count subtitle + right-side actions |
| `FilterBar` / `SearchInput` / `FilterSelect` | `@/components/admin/filter-bar` | The filter row, its search box, and its `<select>` |
| `Th` | `@/components/admin/th` | Standard table header cell (`scope="col"`, `text-caption` uppercase) |
| `Pagination` | `@/components/admin/pagination` | The one list pagination; renders nothing on a single page |
| `DetailHeader` | `@/components/admin/detail-header` | Detail-page header: back-link + title + subtitle + right-side pills/actions |
| `BackLink` | `@/components/admin/back-link` | Chevron back-link (used inside `DetailHeader`) |
| `RowActionMenu` | `@/components/admin/row-action-menu` | Portalled kebab menu for table rows (not clipped by `overflow-x-auto`) |
| `FieldLabel` / `Input` / `Select` / `Textarea` | `@/components/admin/form` | Form primitives — one input look, label↔field association |
| `StatusBadge` / `Pill` | `@/components/status-badge` | The status pill (entity-mapped) and its generic tone-based sibling |

Key signatures (read the source for the full prop list):

```tsx
<PageHeader title="Bookings" subtitle={`${total} bookings`}>{/* actions */}</PageHeader>

<FilterBar>
  <SearchInput value={q} onChange={setQ} placeholder="Search…" ariaLabel="Search bookings" />
  <FilterSelect value={status} onChange={…} aria-label="Filter by status">…</FilterSelect>
</FilterBar>

<Th>Ref</Th>                                   {/* <th scope="col" …> */}

<Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />

<DetailHeader backHref="/admin/bookings" backLabel="Bookings" title={ref} subtitle={addr}>
  <StatusBadge entity="booking" status={status} />
</DetailHeader>

<RowActionMenu actions={[{ label: 'Edit', href: `/admin/x/${id}` }, { label: 'Delete', tone: 'danger', onSelect }]} />

<FieldLabel htmlFor="name">Name</FieldLabel>
<Input id="name" value={name} onChange={…} />       {/* also Select, Textarea; mono? on Input/Textarea */}
```

`Input` / `Select` / `Textarea` pass every native prop through and merge `className` over
the base style via `cn()`, so `<Input className="py-2" />` overrides the base padding.
`SearchInput`, `FilterSelect`, and the `mono` prop are the only bespoke bits.

### Status pills — `StatusBadge` and `Pill`

`StatusBadge` renders a fixed, enumerable status set through `getStatusStyle`; `Pill`
renders a one-off label with a tone. Both share the same pill markup and tokens.

```tsx
<StatusBadge entity="ticket" status={status} dot />   // dot only renders if the entity defines one
<Pill tone="success">Active</Pill>                     // tone: success | warn | error | info | accent | neutral
```

**Entities** (`src/lib/ui/status-styles.ts`, `StatusEntity` union): `booking`, `ncn`, `np`,
`ticket`, `ticketPriority`, `refund`, `bug`, `bugPriority`, `role`, `mudOnboarding`,
`auditAction`. `getStatusStyle(entity, status)` returns `{ bg, text, label, dot? }` and
falls back to a grey pill **echoing the raw status** (never a literal "Unknown") for an
unmapped value. `getStatusOptions(entity)` returns the mapped keys (useful for filter
dropdowns). Every entity backed by a DB enum is pinned in
`src/__tests__/status-styles.test.ts` so a migration that adds a value fails CI instead of
silently degrading in the UI.

**Which one to use:** fixed enumerable set → add/extend an entity and use `StatusBadge`
(typed + exhaustiveness-tested). One-off label with no fixed set → `Pill tone=…`.

---

## How-to

### Build a new admin list page

```tsx
'use client'
import { PageHeader } from '@/components/admin/page-header'
import { FilterBar, SearchInput, FilterSelect } from '@/components/admin/filter-bar'
import { Th } from '@/components/admin/th'
import { Pagination } from '@/components/admin/pagination'
import { StatusBadge } from '@/components/status-badge'

export function WidgetsClient() {
  // …useState for search/filters/page, useQuery for data…
  return (
    <>
      <PageHeader title="Widgets" subtitle={`${total} widgets`}>
        {/* optional right-side actions, e.g. a "+ New" Link */}
      </PageHeader>

      <FilterBar>
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(0) }}
          placeholder="Search…" ariaLabel="Search widgets" />
        <FilterSelect value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }}
          aria-label="Filter by status">…</FilterSelect>
      </FilterBar>

      <div className="flex-1 px-7 pb-6">
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="w-full border-collapse tabular-nums">   {/* tabular-nums on the table */}
            <thead><tr><Th>Name</Th><Th>Status</Th><Th /></tr></thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-sm text-gray-400">No widgets found</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-body-sm">{r.name}</td>
                  <td className="px-4 py-3"><StatusBadge entity="booking" status={r.status} /></td>
                  <td className="px-4 py-3">…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </div>
    </>
  )
}
```

`bookings/bookings-list-client.tsx` is the canonical reference. Match the empty-row
`colSpan` to the real column count, and put `tabular-nums` on the `<table>` element.

### Add a status pill for a new status set

1. Add a map to `src/lib/ui/status-styles.ts` using the semantic pairs (`SUCCESS`/`WARN`/
   `ERROR`/`INFO`) — never raw hexes — and register it in the `ENTITIES` object.
2. If it's backed by a DB enum, add a case to `src/__tests__/status-styles.test.ts` so
   coverage is enforced; if it's free text (like `auditAction`), pin the styled key list.
3. Render with `<StatusBadge entity="yourEntity" status={x} />`.

For a **one-off** label that isn't a fixed set, skip the entity and use
`<Pill tone="success|warn|error|info|accent|neutral">…</Pill>`.

### Build an admin form

```tsx
import { FieldLabel, Input, Select, Textarea } from '@/components/admin/form'

<div>
  <FieldLabel htmlFor="code">MUD code</FieldLabel>
  <Input id="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
</div>
```

Every field needs a visible `FieldLabel` bound via matching `htmlFor` / `id` (a11y). Pass
native props straight through; override look with `className` (e.g. `className="py-2"` for a
denser inline editor, `mono` for monospace). Do not define a local `inputClass` string.

### Build a detail page

```tsx
import { DetailHeader } from '@/components/admin/detail-header'
import { StatusBadge } from '@/components/status-badge'

<DetailHeader backHref="/admin/widgets" backLabel="Widgets" title={widget.ref} subtitle={widget.address}>
  <StatusBadge entity="booking" status={widget.status} />
  {/* action buttons go here too — the header wraps on narrow windows */}
</DetailHeader>
```

`DetailHeader` works in both a `'use client'` component and a server `page.tsx` (it's
directive-free). Right-side children are status pills and/or action buttons.

---

## Explanation

### Why the system exists

Before mid-2026 the admin console had drifted: page titles spelled three ways, status
pills rendered through inline markup + local style maps + stock Tailwind colours, section
labels at 10px in some places and 11px in others, and 100+ arbitrary `text-[Npx]` values.
The uniformity work (shipped in releases #274 and #282) collapsed all of that into the
tokens and components above. The value isn't aesthetic — it's that a change to a colour or
a size is now one edit, and a new page is assembled from parts instead of re-derived.

### The `cn()` / tailwind-merge gotcha (read this one)

`cn()` (`src/lib/utils.ts`) runs `tailwind-merge` to resolve conflicting utilities. Stock
tailwind-merge only knows Tailwind's built-in font-size scale, so it classifies our custom
`@theme` sizes (`text-caption`, `text-body-sm`, …) as text **colours**. That means a call
like `cn('text-caption', 'text-gray-500')` looks like two colours conflicting, and the
size is **silently dropped** — the element renders at the inherited 16px.

The fix registers the custom sizes in the font-size class group:

```ts
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['2xs','caption','body-sm','body','subtitle','title','display'] }] } },
})
```

Consequences to remember:
- This is **app-wide**, not admin-only. Public booking and the field PWA also author custom
  size tokens next to colours; they render at their authored size because of this config.
- A **new `--text-*` token must be added to `utils.ts` too**, or it silently drops. The
  regression test derives its token list from `globals.css` and asserts each survives a
  colour merge, so a forgotten registration fails CI.
- Only computed-style measurement catches this class of bug — it type-checks and "looks
  fine" in code review.

### Design decisions (settled — don't re-litigate)

- **D1 — 12/14px stay `text-xs`/`text-sm`.** They're the two most-used sizes; the Tailwind
  built-ins already cover them, so adding custom tokens would be churn for no pixels.
- **D2 — section labels are `text-caption` (11px).** Matches the `Th` primitive so table
  headers and card labels agree; `text-2xs` (10px) is for tiny chips only.
- **Page titles are `text-xl` (20px) via `PageHeader`.** `--text-title` (22px) is for
  modal/hero headings.
- **Status colours: hybrid.** Fixed enumerable sets get a typed, exhaustiveness-tested
  entity (`StatusBadge`); one-off labels get a `Pill tone`. Both are backed by the same
  four semantic tokens, so nobody hand-types a status colour again.

### Trade-offs

- The token scale has no name for 12/14px (you use `text-xs`/`text-sm`), so the scale is
  "custom tokens + two built-ins" rather than fully bespoke. Deliberate (D1) — less to learn.
- `extendTailwindMerge` adds the custom sizes to the size↔`leading-*` conflict group. In
  practice nothing passes a custom size after a `leading-*` in one `cn()`, so there's no
  casualty, but it's the one interaction to keep in mind.

---

## Do / Don't (and how CI checks it)

**Don't:** arbitrary `text-[Npx]` on admin; stock/hex status colours; inline pill markup or
a local `*_STYLE` map; a hand-rolled `<th>` / header / filter row / pagination block; a
local `inputClass` string; a new `--text-*` token in `globals.css` without `utils.ts`.

**Do:** compose the primitives; tokens for every size and status colour; `StatusBadge`
(entities) or `Pill` (tones) for every pill; `FieldLabel` + `htmlFor`/`id` for every field.

Acceptance greps (all should return nothing on the admin tree):

```bash
grep -rE "text-\[[0-9]+px\]" "src/app/(admin)" src/components/admin        # arbitrary sizes
grep -rnE "rounded-full[^\"]*bg-(red|amber|emerald|blue|purple)-(50|100)" "src/app/(admin)"  # stock pills
grep -rn "_STYLE: Record" "src/app/(admin)"                                # local style maps
grep -rn "inputClass = '" "src/app/(admin)"                                # local input styles
```

---

## Provenance

Shipped across releases **#274** (design-debt batch: tokens, `PageHeader`/`FilterBar`/`Th`/
`Pagination`, `StatusBadge`, semantic colours, focus rule) and **#282** (uniformity series:
`Pill` + entities, `DetailHeader`, form primitives, the `cn()` fix). Conventions summarised
in `CLAUDE.md` §21; the source of truth is the code under `src/components/admin/`,
`src/components/status-badge.tsx`, `src/lib/ui/status-styles.ts`, and the `@theme` block in
`src/app/globals.css`.
