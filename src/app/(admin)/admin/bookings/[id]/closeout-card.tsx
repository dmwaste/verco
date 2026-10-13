'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog } from '@base-ui/react/dialog'
import { format } from 'date-fns'
import { StatusBadge } from '@/components/status-badge'
import { FieldLabel, Select, Textarea } from '@/components/admin/form'
import { NCN_REASONS } from '@/lib/ncn/reasons'
import { STREAM_LABEL } from '@/lib/stops/labels'
import type { WasteStream } from '@/lib/stops/stops'
import {
  CORRECTABLE_OUTCOMES,
  canCorrectStopOutcome,
  correctionDeadline,
  isCorrectableOutcome,
  type CorrectableOutcome,
} from '@/lib/stops/outcome-correction'
import { staleActionMessage } from '@/lib/bundle/stale-action'
import { correctStopOutcome } from './actions'

export interface CloseoutStop {
  id: string
  stream: WasteStream
  status: string
  /** The stop's dispatched collection date (YYYY-MM-DD). */
  collectionDate: string
}

export interface CloseoutCorrection {
  id: string
  stopId: string
  fromStatus: string
  toStatus: string
  reason: string
  correctedAt: string
  correctedByName: string
}

type NcnReason = (typeof NCN_REASONS)[number]

const fmtDate = (yyyymmdd: string) => format(new Date(`${yyyymmdd}T00:00:00`), 'd MMM yyyy')

/** What the resident receives — shown before staff commit. */
function residentOutcomeCopy(from: CorrectableOutcome, to: CorrectableOutcome): string {
  if (to === 'Completed') {
    return `The ${from === 'Non-conformance' ? 'non-conformance' : 'nothing presented'} notice is withdrawn and the resident is emailed to disregard it.`
  }
  const notice = to === 'Non-conformance' ? 'a non-conformance notice' : 'a nothing presented notice'
  const replaces = from !== 'Completed' ? ' It tells them it replaces the earlier notice.' : ''
  return `The resident is emailed ${notice} and can dispute it within 14 days.${replaces}`
}

/**
 * Closeout outcomes per collection pass, with the office correction path
 * (ADR 0030): a contractor admin can change a crew's Completed / NCN /
 * Nothing Presented outcome up to 7 days after the collection date. The
 * `correct_stop_outcome` RPC enforces every rule; the gate here only decides
 * whether to offer the button.
 */
export function CloseoutCard({
  stops,
  corrections,
  bookingStatus,
  userRole,
  todayAwst,
}: {
  stops: CloseoutStop[]
  corrections: CloseoutCorrection[]
  bookingStatus: string
  userRole: string | null
  todayAwst: string
}) {
  const router = useRouter()
  const [target, setTarget] = useState<CloseoutStop | null>(null)
  const [toStatus, setToStatus] = useState<CorrectableOutcome | null>(null)
  const [ncnReason, setNcnReason] = useState<NcnReason | ''>('')
  const [residentNotes, setResidentNotes] = useState('')
  const [contractorFault, setContractorFault] = useState(false)
  const [reason, setReason] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const closed = stops.filter((s) => isCorrectableOutcome(s.status))
  if (closed.length === 0) return null

  function openFor(stop: CloseoutStop) {
    setTarget(stop)
    setToStatus(null)
    setNcnReason('')
    setResidentNotes('')
    setContractorFault(false)
    setReason('')
    setError(null)
  }

  async function handleSubmit() {
    if (!target || !toStatus) return
    setIsSaving(true)
    setError(null)
    try {
      const res = await correctStopOutcome({
        stopId: target.id,
        toStatus,
        reason,
        ncnReason: toStatus === 'Non-conformance' && ncnReason ? ncnReason : null,
        residentNotes: toStatus === 'Completed' ? '' : residentNotes,
        contractorFault: toStatus === 'Nothing Presented' && contractorFault,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setTarget(null)
      router.refresh()
    } catch (err) {
      setError(staleActionMessage(err) ?? 'The correction could not be saved. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  const from = target && isCorrectableOutcome(target.status) ? target.status : null
  const canSubmit =
    !!toStatus && reason.trim().length >= 3 && (toStatus !== 'Non-conformance' || ncnReason !== '')

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <h2 className="mb-3.5 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
        Closeout
      </h2>
      <div className="flex flex-col gap-3">
        {closed.map((stop) => {
          const stopCorrections = corrections.filter((c) => c.stopId === stop.id)
          const correctable = canCorrectStopOutcome({
            role: userRole,
            stopStatus: stop.status,
            bookingStatus,
            collectionDate: stop.collectionDate,
            todayAwst,
          })
          return (
            <div key={stop.id} className="rounded-lg border border-gray-100 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body-sm font-medium text-gray-900">{STREAM_LABEL[stop.stream]}</span>
                  <StatusBadge entity="booking" status={stop.status} />
                </div>
                {correctable && (
                  <button
                    type="button"
                    onClick={() => openFor(stop)}
                    className="inline-flex items-center rounded-md border-[1.5px] border-gray-100 bg-white px-3 py-1 text-xs font-semibold text-[#293F52]"
                  >
                    Correct outcome
                  </button>
                )}
              </div>
              <div className="mt-1 text-xs text-gray-500">
                Collection {fmtDate(stop.collectionDate)}
                {correctable && <> · correctable until {fmtDate(correctionDeadline(stop.collectionDate))}</>}
                {userRole === 'contractor-admin' && todayAwst > correctionDeadline(stop.collectionDate) && (
                  <> · correction window closed</>
                )}
              </div>
              {stopCorrections.length > 0 && (
                <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-gray-100 pt-2.5">
                  {stopCorrections.map((c) => (
                    <li key={c.id} className="text-xs text-gray-500">
                      <span className="font-medium text-gray-900">
                        {c.fromStatus} → {c.toStatus}
                      </span>{' '}
                      · {format(new Date(c.correctedAt), 'd MMM yyyy, h:mm a')} · {c.correctedByName}
                      <div className="text-gray-500">&ldquo;{c.reason}&rdquo;</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <Dialog.Root open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
              <Dialog.Title className="font-[family-name:var(--font-heading)] text-lg font-bold text-[#293F52]">
                Correct outcome{target ? ` — ${STREAM_LABEL[target.stream]}` : ''}
              </Dialog.Title>
              {target && from && (
                <p className="mt-1.5 text-body-sm leading-relaxed text-gray-500">
                  The crew recorded this as <strong className="text-gray-900">{from}</strong> on{' '}
                  {fmtDate(target.collectionDate)}.
                </p>
              )}

              <fieldset className="mt-4">
                <legend className="mb-1.5 block text-caption font-semibold uppercase tracking-wide text-gray-500">
                  Change to
                </legend>
                <div className="flex flex-col gap-1.5">
                  {CORRECTABLE_OUTCOMES.filter((o) => o !== from).map((o) => (
                    <label key={o} className="flex items-center gap-2 text-body-sm text-gray-900">
                      <input
                        type="radio"
                        name="correct-outcome"
                        value={o}
                        checked={toStatus === o}
                        onChange={() => setToStatus(o)}
                      />
                      {o}
                    </label>
                  ))}
                </div>
              </fieldset>

              {toStatus === 'Non-conformance' && (
                <div className="mt-4">
                  <FieldLabel htmlFor="correct-ncn-reason">Non-conformance reason</FieldLabel>
                  <Select
                    id="correct-ncn-reason"
                    value={ncnReason}
                    onChange={(e) => setNcnReason(e.target.value as NcnReason | '')}
                  >
                    <option value="">Choose a reason…</option>
                    {NCN_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              {toStatus === 'Nothing Presented' && (
                <label className="mt-4 flex items-center gap-2 text-body-sm text-gray-900">
                  <input
                    type="checkbox"
                    checked={contractorFault}
                    onChange={(e) => setContractorFault(e.target.checked)}
                  />
                  We couldn&apos;t attend (D&amp;M&apos;s fault, not the resident&apos;s)
                </label>
              )}

              {toStatus && toStatus !== 'Completed' && (
                <div className="mt-4">
                  <FieldLabel htmlFor="correct-resident-notes">Notes for the resident (optional)</FieldLabel>
                  <Textarea
                    id="correct-resident-notes"
                    rows={2}
                    maxLength={2000}
                    value={residentNotes}
                    onChange={(e) => setResidentNotes(e.target.value)}
                  />
                </div>
              )}

              <div className="mt-4">
                <FieldLabel htmlFor="correct-reason">Why are you correcting this? (internal)</FieldLabel>
                <Textarea
                  id="correct-reason"
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Crew confirmed they tapped Completed by mistake"
                />
              </div>

              {from && toStatus && (
                <p className="mt-4 rounded-lg bg-status-info-bg px-3 py-2.5 text-body-sm text-status-info">
                  {residentOutcomeCopy(from, toStatus)}
                </p>
              )}

              {error && (
                <p role="alert" className="mt-4 rounded-lg bg-status-error-bg px-3 py-2.5 text-body-sm text-status-error">
                  {error}
                </p>
              )}

              <div className="mt-5 flex gap-2.5">
                <Dialog.Close className="flex-1 rounded-xl border-[1.5px] border-gray-100 bg-white px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-[#293F52]">
                  Cancel
                </Dialog.Close>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit || isSaving}
                  className="flex-1 rounded-xl bg-[#293F52] px-3.5 py-3 font-[family-name:var(--font-heading)] text-sm font-semibold text-white disabled:opacity-50"
                >
                  {isSaving ? 'Saving…' : 'Correct outcome'}
                </button>
              </div>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
