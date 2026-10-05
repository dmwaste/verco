'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAccessibleClientOptions, type ClientOption } from '@/lib/admin/accessible-clients'
import { FieldLabel, Input, Select } from '@/components/admin/form'

/**
 * Last complete calendar month as YYYY-MM — a report for the running month
 * would under-count (the month isn't over yet), so default to the
 * invoiceable one.
 */
export function lastCompleteMonth(now: Date): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Contractor-admin only (gated by the caller, see reports-client.tsx) —
 * downloads the invoice-backing monthly collections statement for a chosen
 * client + month. Deliberately independent of the page's own client/period
 * scope: a contractor-admin generates reports across ANY accessible client,
 * not just the one currently switched to. `/admin/reports/client-report/{pdf,xlsx}`
 * re-derive + re-check the accessible client set server-side (§21), so
 * this picker is UX only, not the authorization boundary.
 */
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

  const ready = Boolean(clientId && month)
  const href = (format: 'pdf' | 'xlsx') =>
    ready ? `/admin/reports/client-report/${format}?client=${clientId}&month=${month}` : undefined
  // Shared 1.5px border keeps the outline Excel button the same height as the PDF one.
  const button = 'rounded-lg border-[1.5px] px-4 py-2.5 text-body font-semibold transition-colors'
  const disabled = 'pointer-events-none border-gray-100 bg-gray-100 text-gray-400'

  return (
    <section className="mb-6">
      <h2 className="mb-3 font-[family-name:var(--font-heading)] text-sm font-bold text-[#293F52]">
        Client Reports
      </h2>
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <p className="mb-4 text-body-sm text-gray-500">
          Monthly collections statement (PDF or Excel) — the quantity record backing the monthly invoice.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <FieldLabel htmlFor="client-report-client">Client</FieldLabel>
            <Select
              id="client-report-client"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-56"
            >
              {clients.length === 0 && <option value="">No clients available</option>}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor="client-report-month">Month</FieldLabel>
            <Input
              id="client-report-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
          <a
            href={href('pdf')}
            download
            aria-disabled={!ready}
            className={`${button} ${
              ready ? 'border-[#293F52] bg-[#293F52] hover:border-[#1A2D3B] hover:bg-[#1A2D3B]' : disabled
            }`}
            // §21: text-white can silently fail under Tailwind v4 + Turbopack —
            // inline fallback so the CTA label can never vanish.
            style={ready ? { color: '#FFFFFF' } : undefined}
          >
            Download PDF
          </a>
          <a
            href={href('xlsx')}
            download
            aria-disabled={!ready}
            className={`${button} ${
              ready ? 'border-gray-200 bg-white hover:border-[#293F52] hover:bg-gray-50' : disabled
            }`}
            style={ready ? { color: '#293F52' } : undefined}
          >
            Download Excel
          </a>
        </div>
      </div>
    </section>
  )
}
