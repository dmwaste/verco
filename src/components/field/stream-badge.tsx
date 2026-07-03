import { STREAM_LABEL } from '@/lib/stops/labels'
import type { WasteStream } from '@/lib/stops/stops'

/**
 * Waste-stream chip for stop cards. Colours are fixed (not white-label
 * brand vars): stream identity must read the same on every tenant so crews
 * working multi-client days never misread a pass.
 */
const STREAM_CLASSES: Record<WasteStream, string> = {
  general: 'bg-[#E8EEF2] text-[#293F52]',
  green: 'bg-[#E5F6EC] text-[#1E7A45]',
  ancillary: 'bg-[#FFF3EA] text-[#8B4000]',
  illegal_dumping: 'bg-[#FFF0F0] text-[#B42318]',
}

export function StreamBadge({ stream }: { stream: WasteStream }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-caption font-semibold ${STREAM_CLASSES[stream]}`}
    >
      {STREAM_LABEL[stream]}
    </span>
  )
}
