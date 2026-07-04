import { cn } from '@/lib/utils'

const BASE_TH =
  'border-b border-gray-100 bg-gray-50 text-left text-caption font-semibold uppercase tracking-wide text-gray-500'

interface ThProps {
  children?: React.ReactNode
  className?: string
  /**
   * DB column key. When set together with `onSort`, the header renders as a
   * sort toggle with a direction indicator; otherwise it's a plain header.
   * Existing `<Th>Label</Th>` usages are unaffected.
   */
  sortKey?: string
  /** The currently-active sort column key (compare against `sortKey`). */
  activeSort?: string
  /** Direction of the active sort. */
  direction?: 'asc' | 'desc'
  onSort?: (key: string) => void
}

/** Standard admin table header cell — optionally a sortable toggle. */
export function Th({ children, className, sortKey, activeSort, direction, onSort }: ThProps) {
  if (sortKey && onSort) {
    const active = activeSort === sortKey
    return (
      <th
        scope="col"
        aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cn(BASE_TH, 'p-0', className)}
      >
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          className="flex w-full items-center gap-1 px-4 py-2.5 text-caption font-semibold uppercase tracking-wide text-gray-500 transition-colors hover:text-[#293F52]"
        >
          {children}
          <SortIndicator active={active} direction={direction} />
        </button>
      </th>
    )
  }

  return (
    <th scope="col" className={cn(BASE_TH, 'px-4 py-2.5', className)}>
      {children}
    </th>
  )
}

/** Neutral up/down chevrons when inactive; a single solid chevron when active. */
function SortIndicator({ active, direction }: { active: boolean; direction?: 'asc' | 'desc' }) {
  if (!active) {
    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-gray-300"
        aria-hidden="true"
      >
        <path d="M8 9l4-5 4 5" />
        <path d="M8 15l4 5 4-5" />
      </svg>
    )
  }
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-[#293F52]"
      aria-hidden="true"
    >
      {direction === 'asc' ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  )
}
