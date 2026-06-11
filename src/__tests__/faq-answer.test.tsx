import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FaqAnswer } from '@/components/faq-answer'

describe('FaqAnswer', () => {
  it('renders plain prose as a paragraph (DEFAULT_FAQS path)', () => {
    const { container } = render(
      <FaqAnswer markdown="Items must be on the verge by 7am on your collection day." />
    )
    const p = container.querySelector('p')
    expect(p).toHaveTextContent('Items must be on the verge by 7am')
  })

  it('renders unordered lists', () => {
    const { container } = render(<FaqAnswer markdown={'- Branches\n- Twigs\n- Palm fronds'} />)
    const items = container.querySelectorAll('ul > li')
    expect(items).toHaveLength(3)
    expect(items[1]).toHaveTextContent('Twigs')
  })

  it('renders ordered lists', () => {
    const { container } = render(<FaqAnswer markdown={'1. Read the terms\n2. Book online'} />)
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
  })

  it('renders GFM tables inside a horizontal-scroll wrapper', () => {
    const md = '| Accepted | Not accepted |\n|---|---|\n| Furniture | Asbestos |'
    const { container } = render(<FaqAnswer markdown={md} />)
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelector('td')).toHaveTextContent('Furniture')
    expect(table?.parentElement?.className).toContain('overflow-x-auto')
  })

  it('renders bold text as strong', () => {
    const { container } = render(<FaqAnswer markdown="Please note: **mixed piles will not be collected**." />)
    expect(container.querySelector('strong')).toHaveTextContent('mixed piles will not be collected')
  })

  it('opens external links in a new tab with noopener', () => {
    const { container } = render(
      <FaqAnswer markdown="[West Metro Recycling Centre](https://www.wmrc.wa.gov.au/)" />
    )
    const a = container.querySelector('a')
    expect(a).toHaveAttribute('href', 'https://www.wmrc.wa.gov.au/')
    expect(a).toHaveAttribute('target', '_blank')
    expect(a).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders relative portal links as plain anchors (no new tab)', () => {
    const { container } = render(<FaqAnswer markdown="[Book a collection](/book)" />)
    const a = container.querySelector('a')
    expect(a).toHaveAttribute('href', '/book')
    expect(a).not.toHaveAttribute('target')
  })

  it('preserves tel: and mailto: links without new-tab attributes', () => {
    const { container } = render(
      <FaqAnswer markdown="Call [9384 6711](tel:0893846711) or email [us](mailto:vergevalet@wmrc.wa.gov.au)." />
    )
    const links = container.querySelectorAll('a')
    expect(links[0]).toHaveAttribute('href', 'tel:0893846711')
    expect(links[1]).toHaveAttribute('href', 'mailto:vergevalet@wmrc.wa.gov.au')
    expect(links[0]).not.toHaveAttribute('target')
  })

  it('strips javascript: URLs (stored XSS guard)', () => {
    const { container } = render(<FaqAnswer markdown="[click me](javascript:alert(1))" />)
    const a = container.querySelector('a')
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:')
  })

  it('never renders raw HTML as elements (stored XSS guard)', () => {
    const { container } = render(
      <FaqAnswer markdown={'Before <script>alert(1)</script> <b>bold</b> <img src=x onerror=alert(1) /> after'} />
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  })

  it('never renders markdown images (tracking-pixel guard)', () => {
    const { container } = render(<FaqAnswer markdown="![pixel](https://tracker.example/p.png)" />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('treats uppercase and protocol-relative URLs as external links', () => {
    const { container } = render(
      <FaqAnswer markdown={'[a](HTTPS://example.com/x) and [b](//example.com/y)'} />
    )
    const links = container.querySelectorAll('a')
    expect(links[0]).toHaveAttribute('target', '_blank')
    expect(links[1]).toHaveAttribute('target', '_blank')
    expect(links[1]).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('degrades malformed tables to readable text without crashing', () => {
    const { container } = render(<FaqAnswer markdown={'| broken | table\n| no separator row'} />)
    expect(container.textContent).toContain('broken')
  })

  it('renders empty input as empty output without crashing', () => {
    const { container } = render(<FaqAnswer markdown="" />)
    expect(container.textContent).toBe('')
  })
})
