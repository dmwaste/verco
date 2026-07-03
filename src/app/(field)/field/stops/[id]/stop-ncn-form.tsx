'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { compressImage } from '@/lib/images/compress'
import { NCN_REASONS } from '@/lib/ncn/reasons'
import { STREAM_LABEL } from '@/lib/stops/labels'
import { raiseNcnForStop } from './actions'
import { cn } from '@/lib/utils'
import { VercoButton } from '@/components/ui/verco-button'
import type { Database } from '@/lib/supabase/types'
import type { StopDetail } from './stop-closeout-client'

type NcnReason = Database['public']['Enums']['ncn_reason']

interface StopNcnFormProps {
  stop: StopDetail
  runHref: string
}

export function StopNcnForm({ stop, runHref }: StopNcnFormProps) {
  const router = useRouter()
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [reason, setReason] = useState<NcnReason | null>(null)
  const [notes, setNotes] = useState('')
  const [photos, setPhotos] = useState<string[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    setIsUploading(true)
    setError(null)
    const newUrls: string[] = []
    let failed = 0

    try {
      for (const file of Array.from(files)) {
        // Downscale before upload — crew phones shoot 12MP+, and originals
        // stall the closeout flow on 4G. compressImage re-encodes as JPEG.
        const blob = await compressImage(file)
        const path = `${stop.booking.id}/${crypto.randomUUID()}.jpg`

        const { data, error: uploadError } = await supabase.storage
          .from('ncn-photos')
          .upload(path, blob, { contentType: 'image/jpeg' })

        if (!uploadError && data) {
          const { data: urlData } = supabase.storage
            .from('ncn-photos')
            .getPublicUrl(data.path)
          newUrls.push(urlData.publicUrl)
        } else {
          failed++
        }
      }
    } catch {
      failed++
    } finally {
      // finally: an unexpected throw must never leave the submit button
      // permanently disabled behind a stuck isUploading flag.
      setPhotos((prev) => [...prev, ...newUrls])
      setIsUploading(false)
    }

    // A missing thumbnail is easy to miss in glare/gloves — say it loudly
    // so the crew never submits thinking the evidence is attached.
    if (failed > 0) {
      setError(`${failed} photo${failed === 1 ? '' : 's'} failed to upload — try again.`)
    }
  }

  async function handleSubmit() {
    if (!reason) {
      setError('Please select a reason.')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // Photos are already uploaded — a retry never re-uploads.
      const result = await raiseNcnForStop(stop.id, reason, notes, photos)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.push(runHref)
      router.refresh()
    } catch {
      setError('No connection — check signal and retry.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <>
      {/* Header */}
      <div className="shrink-0 border-b border-gray-100 bg-white px-5 py-4">
        <Link
          href={`/field/stops/${stop.id}`}
          className="mb-2.5 flex items-center gap-1.5 text-body-sm font-medium text-[#8FA5B8]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          {stop.booking.ref}
        </Link>
        <div className="font-[family-name:var(--font-heading)] text-base font-bold text-[#E53E3E]">
          Non-Conformance — {STREAM_LABEL[stop.stream]}
        </div>
        <div className="mt-0.5 text-body-sm text-gray-500">{stop.address ?? ''}</div>
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 pb-24 pt-4">
        {/* Reason grid */}
        <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
          <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
            Reason
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {NCN_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={cn(
                  'rounded-lg border-[1.5px] px-2.5 py-2 text-center text-caption font-medium transition-colors',
                  reason === r
                    ? 'border-[#E53E3E] bg-[#FFF0F0] text-[#E53E3E]'
                    : 'border-gray-100 bg-white text-gray-700'
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Photos */}
        <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
          <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
            Photos
          </div>
          <div className="flex flex-wrap gap-2">
            {photos.map((url, i) => (
              <div
                key={i}
                className="size-[72px] overflow-hidden rounded-lg bg-gray-100"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`NCN photo ${i + 1}`}
                  className="size-full object-cover"
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex size-[72px] items-center justify-center rounded-lg border-2 border-dashed border-gray-300"
            >
              {isUploading ? (
                <span className="text-2xs text-gray-400">...</span>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#B0B0B0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="5" width="20" height="15" rx="2"/>
                  <circle cx="12" cy="12" r="4"/>
                  <path d="M9 5l1.5-2h3L15 5"/>
                  <line x1="18" y1="2" x2="18" y2="6"/>
                  <line x1="16" y1="4" x2="20" y2="4"/>
                </svg>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              onChange={handlePhotoUpload}
              className="hidden"
            />
          </div>
        </div>

        {/* Notes */}
        <div className="flex flex-col gap-2 rounded-xl bg-white p-3.5 shadow-sm">
          <div className="text-2xs font-semibold uppercase tracking-wide text-gray-500">
            Notes
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add details about the non-conformance..."
            className="h-[72px] w-full resize-none rounded-[10px] border-[1.5px] border-gray-100 bg-gray-50 px-3.5 py-3 text-body-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-[var(--brand)] focus:bg-white"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">
            {error}
          </div>
        )}

        {/* Submit */}
        <VercoButton
          variant="destructive"
          className="w-full"
          type="button"
          onClick={handleSubmit}
          disabled={isSubmitting || isUploading || !reason}
        >
          {isSubmitting ? 'Submitting...' : 'Submit Non-Conformance Notice'}
        </VercoButton>
      </div>
    </>
  )
}
