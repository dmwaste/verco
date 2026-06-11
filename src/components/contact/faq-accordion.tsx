'use client'

import { useState, type ReactNode } from 'react'

interface FaqAccordionProps {
  /** answer is a ReactNode so the (server) page can pass pre-rendered
   * markdown — see FaqAnswer. Plain strings still work. */
  faqs: { question: string; answer: ReactNode }[]
}

export function FaqAccordion({ faqs }: FaqAccordionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  function toggle(index: number) {
    setOpenIndex((prev) => (prev === index ? null : index))
  }

  if (faqs.length === 0) return null

  return (
    <div className="rounded-xl bg-white shadow-sm">
      {faqs.map((faq, i) => {
        const isOpen = openIndex === i
        const isLast = i === faqs.length - 1

        return (
          <div
            key={i}
            className={!isLast ? 'border-b border-gray-100' : undefined}
          >
            <button
              type="button"
              onClick={() => toggle(i)}
              aria-expanded={isOpen}
              aria-controls={`faq-panel-${i}`}
              className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
            >
              <span className="text-sm font-semibold text-[var(--brand)] md:text-base">
                {faq.question}
              </span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#8FA5B8"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {/* grid-rows 0fr→1fr animates to natural content height (no clip cap).
                inert keeps collapsed content out of the tab order — answers
                contain real links now. */}
            <div
              id={`faq-panel-${i}`}
              inert={!isOpen}
              className="grid transition-[grid-template-rows] duration-200 ease-in-out"
              style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
            >
              <div className="overflow-hidden">
                <div className="px-5 pb-4 text-sm leading-relaxed text-gray-600">
                  {faq.answer}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
