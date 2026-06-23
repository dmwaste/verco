'use client'

import { Dialog } from '@base-ui/react/dialog'
import { useState } from 'react'
import { FaqAnswer } from '@/components/faq-answer'
import { VercoButton } from '@/components/ui/verco-button'

/**
 * Per-client Terms & Conditions acceptance gate, shown before a booking is
 * submitted. Renders the client's markdown via the shared FaqAnswer renderer
 * (no rehype-raw — admin-authored multi-tenant content stays inert). A single
 * required checkbox gates the Accept button (no scroll-gate — the server-side
 * snapshot + timestamp is the legal record). Dismiss (Esc/backdrop/Cancel) =
 * decline: the dialog closes and the booking does not proceed.
 *
 * Layout: fixed title header, scrollable markdown body, pinned footer — so the
 * checkbox + actions never scroll out of reach on long terms (mobile-first).
 */
export function TermsAcceptanceDialog({
  open,
  termsMarkdown,
  onAccept,
  onCancel,
}: {
  open: boolean
  termsMarkdown: string
  onAccept: () => void
  onCancel: () => void
}) {
  const [checked, setChecked] = useState(false)

  function close() {
    setChecked(false)
    onCancel()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) close() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <Dialog.Title className="shrink-0 border-b border-gray-100 px-5 py-4 font-[family-name:var(--font-heading)] text-subtitle font-bold text-[var(--brand)]">
              Terms &amp; Conditions
            </Dialog.Title>

            {/* Scrollable markdown body */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-body-sm leading-relaxed text-gray-700">
              <FaqAnswer markdown={termsMarkdown} />
            </div>

            {/* Pinned footer: checkbox + actions */}
            <div className="shrink-0 border-t border-gray-100 px-5 py-4">
              <label
                htmlFor="tcs-accept"
                className="mb-3 flex cursor-pointer items-start gap-2.5 text-body-sm text-gray-700"
              >
                <input
                  id="tcs-accept"
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
                />
                <span>I have read and accept the Terms &amp; Conditions.</span>
              </label>
              <div className="flex gap-2.5">
                <VercoButton variant="secondary" className="flex-1" onClick={close}>
                  Cancel
                </VercoButton>
                <VercoButton
                  className="flex-1"
                  disabled={!checked}
                  onClick={() => {
                    setChecked(false)
                    onAccept()
                  }}
                >
                  Accept &amp; continue
                </VercoButton>
              </div>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
