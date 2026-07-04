import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from 'react'
import { cn } from '@/lib/utils'

// The one admin form-field style. Callers override width/size via `className`
// (cn runs tailwind-merge, so e.g. `w-20`/`py-2` win over the base).
const FIELD_BASE =
  'w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white'

/** Standard admin field label — pairs with a field via htmlFor/id. */
export function FieldLabel({
  htmlFor,
  children,
  className,
}: {
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('mb-1.5 block text-caption font-semibold uppercase tracking-wide text-gray-500', className)}
    >
      {children}
    </label>
  )
}

export function Input({
  mono,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input {...props} className={cn(FIELD_BASE, mono && 'font-mono', className)} />
}

export function Textarea({
  mono,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea {...props} className={cn(FIELD_BASE, mono && 'font-mono', className)} />
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(FIELD_BASE, className)} />
}
