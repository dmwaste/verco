import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OnBehalfBar } from '@/components/admin/on-behalf-bar'

// The sign-out control posts to a server action; stub it so the bar can render
// in jsdom without pulling the action module's server-only imports.
vi.mock('@/components/auth/sign-out-button', () => ({
  SignOutButton: ({ className }: { className?: string }) => (
    <button className={className}>Sign out</button>
  ),
}))

describe('OnBehalfBar', () => {
  it('names the client the staff user is acting as', () => {
    render(<OnBehalfBar clientName="Verge Valet" />)

    expect(screen.getByText('Acting as')).toBeInTheDocument()
    expect(screen.getByText('Verge Valet')).toBeInTheDocument()
  })

  it('always offers a route back to admin and a sign-out', () => {
    render(<OnBehalfBar clientName="Verge Valet" />)

    const adminLinks = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href') === '/admin')
    // The lockup and the explicit "Back to admin" link both return to /admin.
    expect(adminLinks.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Back to admin/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('renders without the tenant pill when the client cannot be resolved', () => {
    render(<OnBehalfBar clientName={null} />)

    // Degrades to lockup + exit controls rather than showing a blank pill that
    // could be misread as "acting as no-one in particular".
    expect(screen.queryByText('Acting as')).not.toBeInTheDocument()
    expect(screen.getByText(/Back to admin/)).toBeInTheDocument()
  })

  it('does not offer a tenant switcher (mid-flow switching would strand URL params)', () => {
    render(<OnBehalfBar clientName="Verge Valet" />)

    // The wizard threads property_id / collection_area_id between steps, so the
    // tenant must be read-only here. Only sign-out is a button.
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveTextContent('Sign out')
  })
})
