export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E }

export function ok<T>(data: T): Result<T, never> { return { ok: true, data } }
export function err<E = string>(error: E): Result<never, E> { return { ok: false, error } }
