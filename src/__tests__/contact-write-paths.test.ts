import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every contact write goes through the ADR 0027 rule (#631).
 *
 * Contacts are found by email, and an email is not always one person: staff took
 * phone bookings under the WMRC office address, so one contact sat on 278
 * residents' bookings. Any path that finds a contact by email and then UPDATEs it
 * rewrites every one of those bookings (12/10/2026). The only code allowed to
 * update a contacts row is the code that decides via resolveContact:
 * create-booking §7 and the shared attachContact helper. Staff edits go through
 * the update_booking_contact / upsert_strata_contact_and_link RPCs (SQL
 * equivalent, migration 20261012150000), never a direct UPDATE.
 */

const ROOT = join(__dirname, '../..')
const ALLOWED_UPDATERS = new Set([
  'supabase/functions/create-booking/index.ts',
  'supabase/functions/_shared/contact-attach.ts',
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

// Strip comments so prose naming the anti-pattern doesn't count as code.
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const CONTACT_UPDATE = /\.from\('contacts'\)\s*\.update\(/

describe('contact write paths (ADR 0027)', () => {
  it('nothing outside resolveContact updates a contacts row', () => {
    const offenders = [join(ROOT, 'supabase/functions'), join(ROOT, 'src')]
      .flatMap(sourceFiles)
      .map((path) => relative(ROOT, path))
      .filter((rel) => !ALLOWED_UPDATERS.has(rel) && CONTACT_UPDATE.test(code(join(ROOT, rel))))
    expect(offenders).toEqual([])
  })

  it.each(['create-ticket', 'create-user'])('%s attaches its contact through attachContact', (fn) => {
    const src = code(join(ROOT, `supabase/functions/${fn}/index.ts`))
    expect(src).toContain("from '../_shared/contact-attach.ts'")
    expect(src).toMatch(/attachContact\(/)
  })
})
