import { describe, it, expect } from 'vitest'
import { splitAddress, formatTime, getStopMapsUrl } from '@/lib/stops/labels'

describe('splitAddress', () => {
  it('splits street from suburb on the first comma', () => {
    expect(splitAddress('23 Leda Boulevard, Wellard')).toEqual({
      street: '23 Leda Boulevard',
      suburb: 'Wellard',
    })
  })

  it('keeps later commas with the suburb', () => {
    expect(splitAddress('5 Sunset Rise, Bertram, WA')).toEqual({
      street: '5 Sunset Rise',
      suburb: 'Bertram, WA',
    })
  })

  it('treats a comma-less address as all street', () => {
    expect(splitAddress('7 Parkside Loop')).toEqual({ street: '7 Parkside Loop', suburb: '' })
  })

  it('handles null', () => {
    expect(splitAddress(null)).toEqual({ street: '', suburb: '' })
  })
})

describe('formatTime', () => {
  it('formats a Postgres time to h:mma', () => {
    expect(formatTime('06:05:00')).toBe('6:05am')
    expect(formatTime('14:30:00')).toBe('2:30pm')
  })

  it('returns null for null or malformed input', () => {
    expect(formatTime(null)).toBeNull()
    expect(formatTime('not-a-time')).toBeNull()
  })
})

describe('getStopMapsUrl', () => {
  it('prefers coordinates, falls back to address, else null', () => {
    expect(getStopMapsUrl(-32.1, 115.8, 'x')).toBe('https://maps.google.com/?q=-32.1,115.8')
    expect(getStopMapsUrl(null, null, '5 Sunset Rise, Bertram')).toBe(
      'https://maps.google.com/?q=5%20Sunset%20Rise%2C%20Bertram',
    )
    expect(getStopMapsUrl(null, null, null)).toBeNull()
  })
})
