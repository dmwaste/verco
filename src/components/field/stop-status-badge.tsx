import type { StopStatus } from '@/lib/stops/stops'

const STATUS_CLASSES: Record<StopStatus, string> = {
  Pending: 'bg-[#E8EEF2] text-[#293F52]',
  Completed: 'bg-[#E5F6EC] text-[#1E7A45]',
  'Non-conformance': 'bg-[#FFF0F0] text-[#B42318]',
  'Nothing Presented': 'bg-[#FFF3EA] text-[#8B4000]',
  Cancelled: 'bg-gray-100 text-gray-500',
}

export function StopStatusBadge({ status }: { status: StopStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_CLASSES[status]}`}
    >
      {status}
    </span>
  )
}
