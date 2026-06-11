'use client'

import Link from 'next/link'
import { Menu } from '@base-ui/react/menu'

export interface RowAction {
  label: string
  /** Click handler — ignored when `href` is set. */
  onSelect?: () => void
  /** Renders the item as a Next.js Link instead of a button. */
  href?: string
  tone?: 'default' | 'danger' | 'success'
}

const TONE_CLASSES: Record<NonNullable<RowAction['tone']>, string> = {
  default: 'text-gray-700',
  danger: 'text-red-600',
  success: 'text-emerald-600',
}

const ITEM_CLASSES =
  'flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left text-body-sm outline-none data-[highlighted]:bg-gray-50'

/**
 * Portalled row-action kebab menu for admin tables. Replaces the per-table
 * hand-rolled absolute dropdowns that were clipped by `overflow-x-auto` table
 * cards — the portal renders the popup outside the scroll container and
 * Base UI flips it automatically when there is no room below.
 */
export function RowActionMenu({
  actions,
  ariaLabel = 'Open actions menu',
}: {
  actions: RowAction[]
  ariaLabel?: string
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 data-[popup-open]:bg-gray-100 data-[popup-open]:text-gray-600"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
        </svg>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup className="w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg outline-none">
            {actions.map((action) =>
              action.href ? (
                <Menu.LinkItem
                  key={action.label}
                  closeOnClick
                  render={<Link href={action.href} />}
                  className={`${ITEM_CLASSES} ${TONE_CLASSES[action.tone ?? 'default']}`}
                >
                  {action.label}
                </Menu.LinkItem>
              ) : (
                <Menu.Item
                  key={action.label}
                  onClick={action.onSelect}
                  className={`${ITEM_CLASSES} ${TONE_CLASSES[action.tone ?? 'default']}`}
                >
                  {action.label}
                </Menu.Item>
              )
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
