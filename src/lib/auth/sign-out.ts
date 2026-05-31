// Pure sign-out helpers. Kept OUT of the `'use server'` actions file because
// that file may only export async functions — a sync helper there fails the
// build (memory: use-server-non-async-export).

export type SignOutDestination = 'login' | 'home'

/**
 * Maps a sign-out destination to a hardcoded internal path.
 *
 * The destination arrives from a hidden form field, so it is user-tamperable.
 * This function only ever returns one of two hardcoded internal paths and never
 * echoes the input as a URL — so a tampered value can at worst land the user on
 * `/auth`. No open-redirect surface.
 */
export function signOutRedirectPath(destination: unknown): '/' | '/auth' {
  return destination === 'home' ? '/' : '/auth'
}
