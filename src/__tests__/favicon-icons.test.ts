import { describe, it, expect } from 'vitest'
import { faviconToIcons } from '@/lib/client/favicon'

describe('faviconToIcons', () => {
  it('returns undefined when there is no favicon (inherit the default)', () => {
    expect(faviconToIcons(null)).toBeUndefined()
    expect(faviconToIcons(undefined)).toBeUndefined()
    expect(faviconToIcons('')).toBeUndefined()
  })

  it('maps a PNG favicon with an image/png type hint', () => {
    expect(faviconToIcons('https://cdn/c/favicon-123.png')).toEqual({
      icon: [{ url: 'https://cdn/c/favicon-123.png', type: 'image/png' }],
    })
  })

  it('maps an SVG favicon with an image/svg+xml type hint', () => {
    expect(faviconToIcons('https://cdn/c/mark.svg')).toEqual({
      icon: [{ url: 'https://cdn/c/mark.svg', type: 'image/svg+xml' }],
    })
  })

  it('derives the type case-insensitively', () => {
    expect(faviconToIcons('https://cdn/c/MARK.SVG')).toEqual({
      icon: [{ url: 'https://cdn/c/MARK.SVG', type: 'image/svg+xml' }],
    })
  })

  it('strips query string and hash before deriving the type', () => {
    expect(faviconToIcons('https://cdn/c/favicon.png?v=2#frag')).toEqual({
      icon: [{ url: 'https://cdn/c/favicon.png?v=2#frag', type: 'image/png' }],
    })
  })

  it('defaults to image/png when the URL has no extension', () => {
    expect(faviconToIcons('https://cdn/c/icon')).toEqual({
      icon: [{ url: 'https://cdn/c/icon', type: 'image/png' }],
    })
  })
})
