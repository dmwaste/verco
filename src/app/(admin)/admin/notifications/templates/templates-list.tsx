'use client'

import Link from 'next/link'
import type { TemplateCatalogEntry } from './registry'

interface Props {
  entries: TemplateCatalogEntry[]
}

export function TemplatesList({ entries }: Props) {
  return (
    <div>
      {/* Header */}
      <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <h1 className="font-[family-name:var(--font-heading)] text-title font-semibold text-gray-900">
          Notification templates
        </h1>
        <p className="mt-1 text-body-sm text-gray-500">
          {entries.length} transactional templates. Preview rendered HTML per
          tenant or click through to GitHub to propose code changes.
        </p>
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 gap-4 px-7 py-6 md:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <Link
            key={entry.type}
            href={`/admin/notifications/templates/${entry.type}`}
            className="group flex flex-col rounded-xl border border-gray-100 bg-white p-5 shadow-sm transition-colors hover:border-[#293F52]"
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <div className="font-[family-name:var(--font-heading)] text-base font-semibold text-gray-900 group-hover:text-[#293F52]">
                {entry.label}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                {entry.channels.map((ch) => (
                  <span
                    key={ch}
                    className={
                      ch === 'sms'
                        ? 'rounded bg-green-50 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-green-700'
                        : 'rounded bg-blue-50 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-blue-700'
                    }
                  >
                    {ch}
                  </span>
                ))}
              </div>
            </div>
            <code className="mb-3 text-2xs text-gray-400">{entry.type}</code>
            <p className="text-body-sm leading-relaxed text-gray-600">
              {entry.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
