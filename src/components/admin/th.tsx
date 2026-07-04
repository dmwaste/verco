import { cn } from '@/lib/utils'

/** Standard admin table header cell. */
export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-gray-100 bg-gray-50 px-4 py-2.5 text-left text-caption font-semibold uppercase tracking-wide text-gray-500',
        className
      )}
    >
      {children}
    </th>
  )
}
