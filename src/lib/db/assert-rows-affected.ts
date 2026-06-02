import type { Result } from '@/lib/result'
import { err, ok } from '@/lib/result'

/**
 * Guard against silent RLS no-ops.
 *
 * A PostgREST `UPDATE`/`DELETE` that matches zero rows — e.g. because an RLS
 * policy blocked it — returns **no error** and an **empty data array**. Callers
 * that only check `error` then report a false success (the F5/VER-247 cancel
 * bug: the booking never changed, but the action returned `ok` and the UI
 * silently refreshed). Always run mutations with `.select(...)` and pass the
 * result here so "0 rows changed" becomes an explicit `Result` error.
 *
 * @param data    the `data` from a `.update(...).select(...)` / `.delete().select(...)`
 * @param error   the `error` from the same call
 * @param emptyMessage user-facing message when the mutation matched no rows
 */
export function assertRowsAffected<T>(
  data: T[] | null,
  error: { message: string } | null,
  emptyMessage: string,
): Result<T[]> {
  if (error) return err(error.message)
  if (!data || data.length === 0) return err(emptyMessage)
  return ok(data)
}
