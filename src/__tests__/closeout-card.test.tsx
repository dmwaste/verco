import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

const correctStopOutcome = vi.fn()
vi.mock('@/app/(admin)/admin/bookings/[id]/actions', () => ({
  correctStopOutcome: (...args: unknown[]) => correctStopOutcome(...args),
}))

import { CloseoutCard } from '@/app/(admin)/admin/bookings/[id]/closeout-card'

/**
 * Office closeout correction UI (ADR 0030). The RPC enforces the rules; this
 * pins who is OFFERED the correction and what the dialog sends.
 */

const STOP_ID = '11111111-1111-4111-8111-111111111111'
type Props = ComponentProps<typeof CloseoutCard>

const props = (over: Partial<Props> = {}): Props => ({
  stops: [{ id: STOP_ID, stream: 'general', status: 'Completed', collectionDate: '2026-10-13' }],
  corrections: [],
  bookingStatus: 'Completed',
  userRole: 'contractor-admin',
  todayAwst: '2026-10-13',
  ...over,
})

beforeEach(() => {
  correctStopOutcome.mockReset()
  refresh.mockReset()
})

describe('CloseoutCard', () => {
  it('renders nothing when no pass has been closed out', () => {
    const { container } = render(
      <CloseoutCard {...props({ stops: [{ id: STOP_ID, stream: 'general', status: 'Pending', collectionDate: '2026-10-13' }] })} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('offers the correction to a contractor admin inside the 7-day window', () => {
    render(<CloseoutCard {...props()} />)
    expect(screen.getByRole('button', { name: 'Correct outcome' })).toBeInTheDocument()
    expect(screen.getByText(/correctable until 20 Oct 2026/)).toBeInTheDocument()
  })

  it('shows the outcome but no correction to contractor staff', () => {
    render(<CloseoutCard {...props({ userRole: 'contractor-staff' })} />)
    expect(screen.getByText('General')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correct outcome' })).not.toBeInTheDocument()
  })

  it('closes the correction after the window', () => {
    render(<CloseoutCard {...props({ todayAwst: '2026-10-21' })} />)
    expect(screen.queryByRole('button', { name: 'Correct outcome' })).not.toBeInTheDocument()
    expect(screen.getByText(/correction window closed/)).toBeInTheDocument()
  })

  it('does not offer a correction on a rebooked booking', () => {
    render(<CloseoutCard {...props({ bookingStatus: 'Rebooked', stops: [{ id: STOP_ID, stream: 'general', status: 'Non-conformance', collectionDate: '2026-10-13' }] })} />)
    expect(screen.queryByRole('button', { name: 'Correct outcome' })).not.toBeInTheDocument()
  })

  it('lists past corrections with who, what and why', () => {
    render(
      <CloseoutCard
        {...props({
          corrections: [
            {
              id: 'c1',
              stopId: STOP_ID,
              fromStatus: 'Non-conformance',
              toStatus: 'Completed',
              reason: 'Crew confirmed it was collected',
              correctedAt: '2026-10-13T04:00:00Z',
              correctedByName: 'Ben Davies',
            },
          ],
        })}
      />,
    )
    expect(screen.getByText('Non-conformance → Completed')).toBeInTheDocument()
    expect(screen.getByText(/Ben Davies/)).toBeInTheDocument()
    expect(screen.getByText(/Crew confirmed it was collected/)).toBeInTheDocument()
  })

  it('Completed → NCN: needs an NCN reason and an internal reason, then sends them', async () => {
    correctStopOutcome.mockResolvedValue({ ok: true, data: { bookingStatus: 'Non-conformance' } })
    render(<CloseoutCard {...props()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Correct outcome' }))
    // The current outcome is not offered as a target.
    expect(screen.queryByRole('radio', { name: 'Completed' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Non-conformance' }))
    expect(screen.getByText(/can dispute it within 14 days/)).toBeInTheDocument()

    const submit = () => screen.getAllByRole('button', { name: 'Correct outcome' }).at(-1)!
    fireEvent.change(screen.getByLabelText(/Why are you correcting this/), {
      target: { value: 'Crew tapped Completed by mistake' },
    })
    expect(submit()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Non-conformance reason'), { target: { value: 'Building Waste' } })
    fireEvent.change(screen.getByLabelText(/Notes for the resident/), { target: { value: 'Bricks on verge' } })
    expect(submit()).toBeEnabled()
    fireEvent.click(submit())

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(correctStopOutcome).toHaveBeenCalledWith({
      stopId: STOP_ID,
      toStatus: 'Non-conformance',
      reason: 'Crew tapped Completed by mistake',
      ncnReason: 'Building Waste',
      residentNotes: 'Bricks on verge',
      contractorFault: false,
    })
  })

  it('shows the database refusal in the dialog and stays open', async () => {
    correctStopOutcome.mockResolvedValue({ ok: false, error: 'The notice is already Disputed.' })
    render(
      <CloseoutCard
        {...props({ stops: [{ id: STOP_ID, stream: 'green', status: 'Non-conformance', collectionDate: '2026-10-13' }], bookingStatus: 'Non-conformance' })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Correct outcome' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Completed' }))
    expect(screen.getByText(/notice is withdrawn and the resident is emailed to disregard it/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Why are you correcting this/), { target: { value: 'It was collected' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Correct outcome' }).at(-1)!)

    expect(await screen.findByRole('alert')).toHaveTextContent('The notice is already Disputed.')
    expect(refresh).not.toHaveBeenCalled()
  })
})
