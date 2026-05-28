export type Result<T, E = string> = { ok: true; data: T } | { ok: false; error: E }
