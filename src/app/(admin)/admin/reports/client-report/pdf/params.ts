import { z } from 'zod'
import type { Result } from '@/lib/result'

const schema = z.object({
  clientId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
})

export interface ReportParams {
  clientId: string
  month: string // YYYY-MM
  monthStart: string // YYYY-MM-01 (RPC arg)
}

export function parseReportParams(clientId: unknown, month: unknown): Result<ReportParams> {
  const p = schema.safeParse({ clientId, month })
  if (!p.success) return { ok: false, error: 'Invalid client or month' }
  return { ok: true, data: { ...p.data, monthStart: `${p.data.month}-01` } }
}
