import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * correctStopOutcome (ADR 0030): the RPC enforces the rules (verified on prod
 * in a rolled-back block); this pins the action's own contract — fail closed
 * before the RPC on role/input, surface RPC refusals verbatim, and send the
 * resident the email that matches the corrected outcome.
 */

const STOP = '11111111-1111-4111-8111-111111111111'
const BOOKING = '22222222-2222-4222-8222-222222222222'
const CORRECTION = '33333333-3333-4333-8333-333333333333'
const NOTICE = '44444444-4444-4444-8444-444444444444'

const h = vi.hoisted(() => ({
  role: 'contractor-admin' as string | null,
  rpcResult: { data: null as unknown, error: null as { message: string } | null },
  stop: { stream: 'general', services_summary: [{ name: 'Bulk Waste' }] } as unknown,
  siblings: [] as unknown[],
  rpcCalls: [] as Array<[string, unknown]>,
}))

vi.mock('@/lib/notifications/invoke', () => ({ invokeSendNotification: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: unknown) => {
        h.rpcCalls.push([name, args])
        if (name === 'current_user_role') return Promise.resolve({ data: h.role, error: null })
        return Promise.resolve(h.rpcResult)
      },
      from: () => {
        const builder: Record<string, unknown> = {}
        builder.select = () => builder
        builder.eq = () => builder
        builder.neq = () => builder
        builder.single = () => Promise.resolve({ data: h.stop, error: null })
        // List query (sibling stops) — awaited directly.
        builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: h.siblings, error: null })
        return builder
      },
    }),
}))

import { correctStopOutcome } from '@/app/(admin)/admin/bookings/[id]/actions'
import { invokeSendNotification } from '@/lib/notifications/invoke'

const sent = vi.mocked(invokeSendNotification)

function rpcOk(from: string, to: string, extra: Record<string, unknown> = {}) {
  h.rpcResult = {
    data: {
      correction_id: CORRECTION,
      booking_id: BOOKING,
      from_status: from,
      to_status: to,
      withdrawn_notice_id: null,
      new_notice_id: to === 'Completed' ? null : NOTICE,
      photos: [],
      booking_status: to,
      ...extra,
    },
    error: null,
  }
}

const input = {
  stopId: STOP,
  toStatus: 'Non-conformance' as const,
  reason: 'Crew tapped Completed by mistake',
  ncnReason: 'Building Waste' as const,
  residentNotes: 'Bricks and rubble on the verge',
  contractorFault: false,
}

const correctionRpcCalls = () => h.rpcCalls.filter(([n]) => n === 'correct_stop_outcome')

beforeEach(() => {
  h.role = 'contractor-admin'
  h.rpcCalls = []
  h.siblings = []
  sent.mockClear()
})

describe('correctStopOutcome', () => {
  it.each(['contractor-staff', 'client-admin', 'field', null])(
    'refuses %s before touching the RPC',
    async (role) => {
      h.role = role
      const res = await correctStopOutcome(input)
      expect(res.ok).toBe(false)
      expect(correctionRpcCalls()).toHaveLength(0)
      expect(sent).not.toHaveBeenCalled()
    },
  )

  it('requires an NCN reason when correcting to Non-conformance', async () => {
    const res = await correctStopOutcome({ ...input, ncnReason: null })
    expect(res).toEqual({ ok: false, error: 'Choose the non-conformance reason.' })
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('requires an internal reason', async () => {
    const res = await correctStopOutcome({ ...input, reason: ' x ' })
    expect(res.ok).toBe(false)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('surfaces the RPC refusal verbatim and sends nothing', async () => {
    h.rpcResult = { data: null, error: { message: 'The notice is already Disputed.' } }
    const res = await correctStopOutcome(input)
    expect(res).toEqual({ ok: false, error: 'The notice is already Disputed.' })
    expect(sent).not.toHaveBeenCalled()
  })

  it('Completed → NCN: passes the inputs to the RPC and sends the NCN notice', async () => {
    rpcOk('Completed', 'Non-conformance')
    h.siblings = [{ stream: 'green', services_summary: [{ name: 'Green Waste' }] }]

    const res = await correctStopOutcome(input)

    expect(res).toEqual({ ok: true, data: { bookingStatus: 'Non-conformance' } })
    expect(correctionRpcCalls()[0]?.[1]).toEqual({
      p_stop_id: STOP,
      p_to_status: 'Non-conformance',
      p_reason: 'Crew tapped Completed by mistake',
      p_ncn_reason: 'Building Waste',
      p_resident_notes: 'Bricks and rubble on the verge',
      p_contractor_fault: false,
    })
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0]?.[1]).toMatchObject({
      type: 'ncn_raised',
      booking_id: BOOKING,
      ncn_id: NOTICE,
      reason: 'Building Waste',
      notes: 'Bricks and rubble on the verge',
      stream: 'Bulk Waste',
      pending_services: 'Green Waste',
      replaces_earlier_notice: false,
    })
  })

  it('NCN → NP: sends the NP notice flagged as replacing the earlier one, photos carried', async () => {
    rpcOk('Non-conformance', 'Nothing Presented', { photos: ['https://x/p1.jpg'] })

    await correctStopOutcome({
      ...input,
      toStatus: 'Nothing Presented',
      ncnReason: null,
      residentNotes: '',
      contractorFault: true,
    })

    expect(sent.mock.calls[0]?.[1]).toMatchObject({
      type: 'np_raised',
      np_id: NOTICE,
      contractor_fault: true,
      photos: ['https://x/p1.jpg'],
      replaces_earlier_notice: true,
    })
    expect(sent.mock.calls[0]?.[1]).not.toHaveProperty('notes', expect.anything())
  })

  it('NCN → Completed: sends the disregard-the-notice email keyed by the correction', async () => {
    rpcOk('Non-conformance', 'Completed')

    await correctStopOutcome({ ...input, toStatus: 'Completed', ncnReason: null, residentNotes: '' })

    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0]?.[1]).toEqual({
      type: 'closeout_corrected',
      booking_id: BOOKING,
      correction_id: CORRECTION,
      stream: 'Bulk Waste',
    })
  })
})
