import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MultiSelectFilter, type MultiSelectGroup } from '@/components/admin/filter-bar'

/**
 * The bookings screen's multi-select filters (VER-323). Empty = no filter, one
 * tick = the old single select, more ticks OR together; a council group header
 * ticks/unticks all of its areas.
 */

function Harness(props: {
  options?: { value: string; label: string }[]
  groups?: MultiSelectGroup[]
  initial?: string[]
}) {
  const [selected, setSelected] = useState<string[]>(props.initial ?? [])
  return (
    <>
      <MultiSelectFilter
        allLabel="All Statuses"
        pluralNoun="statuses"
        options={props.options}
        groups={props.groups}
        selected={selected}
        onChange={setSelected}
        ariaLabel="Filter by status"
      />
      <output data-testid="selected">{selected.join('|')}</output>
    </>
  )
}

const STATUSES = ['Completed', 'Non-conformance', 'Nothing Presented'].map((s) => ({ value: s, label: s }))

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Filter by status' }))
const selected = () => screen.getByTestId('selected').textContent

describe('MultiSelectFilter', () => {
  it('shows the "All" label when nothing is ticked', () => {
    render(<Harness options={STATUSES} />)
    expect(screen.getByRole('button', { name: 'Filter by status' })).toHaveTextContent('All Statuses')
  })

  it('ticks several values, keeps the menu open, and summarises the count', async () => {
    render(<Harness options={STATUSES} />)
    open()
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Nothing Presented' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Completed' }))

    // Option order, not click order — keeps URLs and query keys stable.
    expect(selected()).toBe('Completed|Nothing Presented')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Completed' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Filter by status' })).toHaveTextContent('2 statuses')
  })

  it('names the single ticked value, like the old single select', () => {
    render(<Harness options={STATUSES} initial={['Non-conformance']} />)
    expect(screen.getByRole('button', { name: 'Filter by status' })).toHaveTextContent('Non-conformance')
  })

  it('unticks a value and clears the whole selection', async () => {
    render(<Harness options={STATUSES} initial={['Completed', 'Nothing Presented']} />)
    open()
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Completed' }))
    expect(selected()).toBe('Nothing Presented')

    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear selection' }))
    expect(selected()).toBe('')
  })

  it('a council header ticks all its areas, then unticks them', async () => {
    const groups: MultiSelectGroup[] = [
      { label: 'Town of Cambridge', options: [{ value: 'a', label: 'CAM-A' }, { value: 'b', label: 'CAM-B' }] },
      { label: 'Town of Cottesloe', options: [{ value: 'c', label: 'COT' }] },
    ]
    render(<Harness groups={groups} initial={['a']} />)
    open()

    const cambridge = await screen.findByRole('menuitemcheckbox', { name: 'Town of Cambridge' })
    // Partly ticked → not "checked"; clicking completes the group.
    expect(cambridge).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(cambridge)
    expect(selected()).toBe('a|b')

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Town of Cambridge' }))
    expect(selected()).toBe('')

    // Areas are still individually tickable inside a group.
    const menu = screen.getByRole('menu')
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'COT' }))
    expect(selected()).toBe('c')
  })
})
