import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FaqAccordion } from '@/components/contact/faq-accordion'

const FAQS = [
  { question: 'What can I put out?', answer: <p>Most household bulk items.</p> },
  { question: 'When do I put it out?', answer: 'By 7am on collection day.' },
]

describe('FaqAccordion', () => {
  it('renders nothing for an empty FAQ list', () => {
    const { container } = render(<FaqAccordion faqs={[]} />)
    expect(container.firstChild).toBeNull()
  })

  // REGRESSION: pre-existing toggle behaviour, untested before the markdown change
  it('toggles a panel open and closed on click', () => {
    render(<FaqAccordion faqs={FAQS} />)
    const button = screen.getByRole('button', { name: /what can i put out/i })
    const panel = document.getElementById('faq-panel-0')!

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel.style.gridTemplateRows).toBe('0fr')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panel.style.gridTemplateRows).toBe('1fr')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel.style.gridTemplateRows).toBe('0fr')
  })

  it('keeps at most one panel open (opening the second closes the first)', () => {
    render(<FaqAccordion faqs={FAQS} />)
    const first = screen.getByRole('button', { name: /what can i put out/i })
    const second = screen.getByRole('button', { name: /when do i put it out/i })

    fireEvent.click(first)
    fireEvent.click(second)
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(second).toHaveAttribute('aria-expanded', 'true')
  })

  it('marks collapsed panels inert so hidden links leave the tab order', () => {
    render(<FaqAccordion faqs={FAQS} />)
    const panel0 = document.getElementById('faq-panel-0')!
    const panel1 = document.getElementById('faq-panel-1')!

    expect(panel0).toHaveAttribute('inert')
    expect(panel1).toHaveAttribute('inert')

    fireEvent.click(screen.getByRole('button', { name: /what can i put out/i }))
    expect(panel0).not.toHaveAttribute('inert')
    expect(panel1).toHaveAttribute('inert')
  })

  it('wires aria-controls from each toggle to its panel', () => {
    render(<FaqAccordion faqs={FAQS} />)
    const button = screen.getByRole('button', { name: /when do i put it out/i })
    expect(button).toHaveAttribute('aria-controls', 'faq-panel-1')
  })

  it('has no fixed max-height cap on open panels (tall tables must not clip)', () => {
    render(<FaqAccordion faqs={FAQS} />)
    const button = screen.getByRole('button', { name: /what can i put out/i })
    fireEvent.click(button)
    const panel = document.getElementById('faq-panel-0')!
    expect(panel.style.maxHeight).toBe('')
  })

  it('survives rapid double-clicks without wedging state', () => {
    render(<FaqAccordion faqs={FAQS} />)
    const button = screen.getByRole('button', { name: /what can i put out/i })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('faq-panel-0')!.style.gridTemplateRows).toBe('0fr')
  })

  it('renders ReactNode answers (pre-rendered markdown from the server)', () => {
    render(<FaqAccordion faqs={FAQS} />)
    fireEvent.click(screen.getByRole('button', { name: /what can i put out/i }))
    expect(screen.getByText('Most household bulk items.')).toBeInTheDocument()
  })
})
