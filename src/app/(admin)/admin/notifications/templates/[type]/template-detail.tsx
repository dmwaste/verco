'use client'

import { useState } from 'react'
import { BackLink } from '@/components/admin/back-link'
import type { TemplateCatalogEntry } from '../registry'
import type { PreviewTenant } from '../preview-fixtures'
import type { RenderedForTenant } from './page'

interface Props {
  entry: TemplateCatalogEntry
  rendered: RenderedForTenant[]
  source: string
  denoMirror: string
  githubViewUrl: string
  githubEditUrl: string
  githubDenoMirrorUrl: string
}

export function TemplateDetail({
  entry,
  rendered,
  source,
  denoMirror,
  githubViewUrl,
  githubEditUrl,
  githubDenoMirrorUrl,
}: Props) {
  const [tenant, setTenant] = useState<PreviewTenant>(rendered[0]!.tenant)
  const [showJson, setShowJson] = useState(false)
  const selected = rendered.find((r) => r.tenant === tenant) ?? rendered[0]!

  return (
    <div>
      {/* Header */}
      <div className="border-b border-gray-100 bg-white px-7 pb-5 pt-6">
        <BackLink href="/admin/notifications/templates" label="Templates" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-[family-name:var(--font-heading)] text-title font-semibold text-gray-900">
              {entry.label}
            </h1>
            <code className="text-2xs text-gray-400">{entry.type}</code>
          </div>
          <div className="flex shrink-0 items-center gap-1">
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
        <p className="mt-2 max-w-3xl text-body-sm text-gray-600">{entry.description}</p>
      </div>

      <div className="space-y-6 px-7 py-6">
        {/* Section 1: Preview */}
        <section className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-[family-name:var(--font-heading)] text-base font-semibold text-gray-900">
              Preview
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-caption font-medium uppercase tracking-wide text-gray-400">
                Tenant
              </span>
              <div className="inline-flex rounded-lg border border-gray-100 bg-gray-50 p-0.5">
                {rendered.map((r) => (
                  <button
                    key={r.tenant}
                    onClick={() => setTenant(r.tenant)}
                    className={
                      tenant === r.tenant
                        ? 'rounded-md bg-white px-3 py-1 text-body-sm font-medium text-[#293F52] shadow-sm'
                        : 'rounded-md px-3 py-1 text-body-sm text-gray-500 hover:text-[#293F52]'
                    }
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Subject line */}
          <div className="mb-3 rounded-md bg-gray-50 px-3 py-2">
            <span className="mr-2 text-caption font-medium uppercase tracking-wide text-gray-400">
              Subject
            </span>
            <span className="text-body-sm text-gray-700">{selected.email.subject}</span>
          </div>

          {/* Email iframe */}
          <div className="overflow-hidden rounded-lg border border-gray-100">
            <iframe
              key={`${entry.type}-${tenant}`}
              srcDoc={selected.email.html}
              title={`${entry.label} — ${selected.label}`}
              className="h-[640px] w-full bg-white"
              sandbox=""
            />
          </div>

          {/* SMS phone mock — only if SMS variant exists */}
          {selected.sms && (
            <div className="mt-6">
              <div className="mb-2 text-caption font-medium uppercase tracking-wide text-gray-400">
                SMS body
              </div>
              <div className="mx-auto max-w-sm rounded-2xl bg-gray-100 p-4 shadow-inner">
                <div className="mb-1 text-2xs text-gray-400">
                  {tenant === 'kwn' ? 'Verco' : tenant === 'vergevalet' ? 'VergeValet' : '(no sender)'}
                </div>
                <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 text-body-sm leading-relaxed text-gray-900 shadow-sm">
                  {selected.sms.body}
                </div>
                <div className="mt-2 text-right text-2xs text-gray-400">
                  {selected.sms.body.length} chars · {Math.ceil(selected.sms.body.length / 160)} segment{Math.ceil(selected.sms.body.length / 160) > 1 ? 's' : ''}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Section 2: Sample inputs */}
        <section className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <button
            onClick={() => setShowJson((v) => !v)}
            className="flex w-full items-center justify-between gap-3"
          >
            <h2 className="font-[family-name:var(--font-heading)] text-base font-semibold text-gray-900">
              Sample inputs
            </h2>
            <span className="text-caption font-medium uppercase tracking-wide text-gray-400">
              {showJson ? 'Hide' : 'Show'}
            </span>
          </button>
          {showJson && (
            <pre className="mt-4 max-h-96 overflow-auto rounded-md bg-gray-50 p-4 text-2xs leading-relaxed text-gray-700">
              {JSON.stringify(selected.booking, null, 2)}
            </pre>
          )}
          {!showJson && (
            <p className="mt-2 text-body-sm text-gray-500">
              The booking shape the preview was rendered against. Useful for
              spotting which values are dynamic vs hard-coded copy.
            </p>
          )}
        </section>

        {/* Section 3: Source code */}
        <section className="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-[family-name:var(--font-heading)] text-base font-semibold text-gray-900">
                Source code
              </h2>
              <code className="text-2xs text-gray-400">{entry.sourceFile}</code>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={githubViewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-2xs font-medium text-gray-700 hover:border-[#293F52] hover:text-[#293F52]"
              >
                View on GitHub
              </a>
              <a
                href={githubEditUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-[#293F52] px-3 py-1.5 text-2xs font-medium text-white hover:bg-[#1e3040]"
              >
                Edit on GitHub
              </a>
            </div>
          </div>
          <div className="mb-3 rounded-md border border-amber-100 bg-amber-50 px-3 py-2 text-2xs text-amber-800">
            <strong className="font-semibold">Mirror obligation:</strong> any
            change here must also be applied to the Deno mirror at{' '}
            <a
              href={githubDenoMirrorUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-amber-300 underline-offset-2 hover:decoration-amber-800"
            >
              <code>{denoMirror}</code>
            </a>
            . The <code>template-sync</code> CI guard enforces this on every PR.
          </div>
          <pre className="max-h-[720px] overflow-auto rounded-md bg-gray-900 p-4 text-2xs leading-relaxed text-gray-100">
            <code>{source}</code>
          </pre>
        </section>
      </div>
    </div>
  )
}
