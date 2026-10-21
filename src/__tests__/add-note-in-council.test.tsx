// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * "Add a note" for a property in another council (VER-321): the property page
 * only opens properties in the switcher's council, so the button switches to
 * the property's council first, then opens it. A refused switch says so and
 * stays put.
 */

const { push, setCurrentAdminClient } = vi.hoisted(() => ({ push: vi.fn(), setCurrentAdminClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/admin/actions', () => ({ setCurrentAdminClient }))

import { AddNoteInCouncil } from '@/app/(admin)/admin/lookup/add-note-in-council'

describe('AddNoteInCouncil', () => {
  beforeEach(() => vi.clearAllMocks())

  it('names the council it will switch to', () => {
    render(<AddNoteInCouncil propertyId="p-1" clientId="vv" clientName="Verge Valet" />)

    expect(screen.getByRole('button', { name: /add a note/i }).textContent).toContain('Verge Valet')
  })

  it('switches council, then opens the property', async () => {
    setCurrentAdminClient.mockResolvedValue({ ok: true, data: { id: 'vv' } })
    render(<AddNoteInCouncil propertyId="p-1" clientId="vv" clientName="Verge Valet" />)

    fireEvent.click(screen.getByRole('button', { name: /add a note/i }))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/properties/p-1'))
    expect(setCurrentAdminClient).toHaveBeenCalledWith('vv')
  })

  it('stays put and says why when the switch is refused', async () => {
    setCurrentAdminClient.mockResolvedValue({ ok: false, error: 'Client not accessible.' })
    render(<AddNoteInCouncil propertyId="p-1" clientId="vv" clientName="Verge Valet" />)

    fireEvent.click(screen.getByRole('button', { name: /add a note/i }))

    expect((await screen.findByRole('alert')).textContent).toContain('Client not accessible.')
    expect(push).not.toHaveBeenCalled()
  })
})
