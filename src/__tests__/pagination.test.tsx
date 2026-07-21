import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Pagination } from '@/components/admin/pagination'

describe('Pagination', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(
      <Pagination page={0} pageSize={25} total={20} onPageChange={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('pages forward and back, disabling the buttons at the bounds', () => {
    const onPageChange = vi.fn()
    const { rerender } = render(
      <Pagination page={0} pageSize={25} total={60} onPageChange={onPageChange} />
    )

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onPageChange).toHaveBeenCalledWith(1)

    rerender(<Pagination page={2} pageSize={25} total={60} onPageChange={onPageChange} />)
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(onPageChange).toHaveBeenCalledWith(1)
  })

  // REGRESSION: the bug-report FAB is `fixed bottom-6 right-6` on tablet+ and
  // permanently covered the right-aligned Next button at full scroll (the
  // pagination row is the last element on every admin list page, so it could
  // never scroll clear). The wrapper must reserve desktop bottom clearance
  // taller than the FAB's footprint.
  it('reserves tablet bottom clearance so the FAB cannot cover the Next button', () => {
    const { container } = render(
      <Pagination page={0} pageSize={25} total={60} onPageChange={() => {}} />
    )
    expect((container.firstChild as HTMLElement).className).toContain('tablet:mb-20')
  })

  it('keeps the clearance when a consumer passes extra classes', () => {
    const { container } = render(
      <Pagination className="mx-7" page={0} pageSize={25} total={60} onPageChange={() => {}} />
    )
    const cls = (container.firstChild as HTMLElement).className
    expect(cls).toContain('tablet:mb-20')
    expect(cls).toContain('mx-7')
  })
})
