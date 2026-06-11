import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FaqsTab } from '@/app/(admin)/admin/clients/[id]/tabs/faqs-tab'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}))

const updateClientFaqs = vi.fn(async () => ({ ok: true as const, data: undefined }))
vi.mock('@/app/(admin)/admin/clients/actions', () => ({
  updateClientFaqs: (...args: unknown[]) => updateClientFaqs(...(args as [])),
}))

function makeClient(faqs: { question: string; answer: string }[]) {
  return { id: 'client-1', faq_items: faqs } as unknown as Parameters<typeof FaqsTab>[0]['client']
}

const TWO_FAQS = [
  { question: 'First question?', answer: 'First answer.' },
  { question: 'Second question?', answer: 'Second answer.' },
]

function arrowButtons(direction: 'up' | 'down') {
  const arrow = direction === 'up' ? '▲' : '▼'
  return screen.getAllByRole('button').filter((b) => b.textContent === arrow)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FaqsTab', () => {
  it('shows corrected helper copy with the markdown hint', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    expect(screen.getByText(/public contact page/i)).toBeInTheDocument()
    expect(screen.getByText(/markdown supported/i)).toBeInTheDocument()
  })

  it('renders a live markdown preview while editing', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])

    const textarea = screen.getByPlaceholderText(/answer/i)
    fireEvent.change(textarea, { target: { value: '| Accepted |\n|---|\n| Furniture |' } })

    expect(screen.getByText('Preview')).toBeInTheDocument()
    expect(document.querySelector('table')).not.toBeNull()
    expect(screen.getByText('Furniture')).toBeInTheDocument()
  })

  it('hides the preview when the answer is empty', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.change(screen.getByPlaceholderText(/answer/i), { target: { value: '   ' } })
    expect(screen.queryByText('Preview')).toBeNull()
  })

  // CRUD backfill — index-juggling logic was previously untested
  it('saves an edited question and answer back to the list', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    fireEvent.change(screen.getByPlaceholderText('Question'), { target: { value: 'Updated question?' } })
    fireEvent.change(screen.getByPlaceholderText(/answer/i), { target: { value: 'Updated answer.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('Updated question?')).toBeInTheDocument()
  })

  it('adds a new FAQ row in edit mode', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    expect(screen.getByPlaceholderText('Question')).toBeInTheDocument()
  })

  it('removes an item', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    expect(screen.queryByText('First question?')).toBeNull()
    expect(screen.getByText('Second question?')).toBeInTheDocument()
  })

  it('moves an item down and back up', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)

    fireEvent.click(arrowButtons('down')[0])
    let questions = screen.getAllByText(/question\?/).map((el) => el.textContent)
    expect(questions[0]).toBe('Second question?')

    fireEvent.click(arrowButtons('up')[1])
    questions = screen.getAllByText(/question\?/).map((el) => el.textContent)
    expect(questions[0]).toBe('First question?')
  })

  it('does not move the first item up or the last item down', () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(arrowButtons('up')[0])
    fireEvent.click(arrowButtons('down')[1])
    const questions = screen.getAllByText(/question\?/).map((el) => el.textContent)
    expect(questions).toEqual(['First question?', 'Second question?'])
  })

  it('persists via updateClientFaqs and reports success', async () => {
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument()
    expect(updateClientFaqs).toHaveBeenCalledWith('client-1', TWO_FAQS)
    expect(refresh).toHaveBeenCalled()
  })

  it('surfaces a server error without clearing the list', async () => {
    updateClientFaqs.mockResolvedValueOnce({ ok: false, error: 'RLS denied' } as never)
    render(<FaqsTab client={makeClient(TWO_FAQS)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByText('RLS denied')).toBeInTheDocument()
    expect(screen.getByText('First question?')).toBeInTheDocument()
  })
})
