import { bookingTypeTag } from '@/lib/stops/stops'

/**
 * Job-type chip for stop cards: MUD (with unit count) or ID. Residential is
 * the unmarked default — the crew's question is "is this NOT a normal verge
 * booking?". Colours are fixed (not white-label brand vars) for the same
 * reason as StreamBadge: a MUD must read the same on every tenant on a
 * multi-council day. MUD reuses the admin purple (status-styles PURPLE), ID
 * the illegal_dumping stream red, so each colour means one thing everywhere.
 * The 1px border tracks the text colour so the pill still reads when the
 * admin run sheet is printed and the browser drops background fills.
 */
const TAG_CLASSES: Record<'MUD' | 'ID', string> = {
  MUD: 'bg-[#F3EEFF] text-[#805AD5]',
  ID: 'bg-[#FFF0F0] text-[#B42318]',
}

interface BookingTypeBadgeProps {
  /** booking.type — the canonical discriminator. */
  type: string
  /** eligible_properties.unit_count; 0 / 1 / null all read as "unknown". */
  unitCount: number | null | undefined
  className?: string
}

export function BookingTypeBadge({ type, unitCount, className }: BookingTypeBadgeProps) {
  const tag = bookingTypeTag(type, unitCount)
  if (!tag) return null
  return (
    <span
      className={`inline-flex shrink-0 whitespace-nowrap rounded-full border border-current px-2.5 py-0.5 text-caption font-semibold ${TAG_CLASSES[tag.code]}${className ? ` ${className}` : ''}`}
    >
      {tag.code}
      {tag.units !== null && ` · ${tag.units} units`}
    </span>
  )
}
