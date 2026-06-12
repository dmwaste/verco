'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { invokeEdgeFunction } from '@/lib/supabase/invoke-ef'
import { cn } from '@/lib/utils'

interface PlaceSuggestion {
  place_id: string
  description: string
}

interface AddressAutocompleteProps {
  onSelect: (placeId: string, description: string) => void
  placeholder?: string
  initialValue?: string
  variant?: 'default' | 'hero'
  /** Forwarded to the underlying <input> so an external <label htmlFor> can bind to it. */
  inputId?: string
}

export function AddressAutocomplete({
  onSelect,
  placeholder = 'Start typing your address...',
  initialValue = '',
  variant = 'default',
  inputId,
}: AddressAutocompleteProps) {
  const [query, setQuery] = useState(initialValue)
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [isOpen, setIsOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sessionTokenRef = useRef(crypto.randomUUID())
  const containerRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const searchPlaces = useCallback(
    async (input: string) => {
      if (input.length < 3) {
        setSuggestions([])
        setIsOpen(false)
        return
      }

      setIsSearching(true)
      try {
        const data = await invokeEdgeFunction<{
          predictions?: Array<{ place_id: string; description: string }>
        }>('google-places-proxy', {
          input,
          session_token: sessionTokenRef.current,
          types: 'address',
          components: 'country:au',
          // D&M operates WA-only — bias ranking to WA and drop interstate matches.
          state: 'WA',
        })

        if (data?.predictions && Array.isArray(data.predictions)) {
          const results = data.predictions.map((p) => ({
            place_id: p.place_id,
            description: p.description,
          }))
          setSuggestions(results)
          setIsOpen(results.length > 0)
          setSelectedIndex(-1)
        }
      } catch (err) {
        console.error('[AddressAutocomplete] google-places-proxy error:', err)
      } finally {
        setIsSearching(false)
      }
    },
    []
  )

  function handleInputChange(value: string) {
    setQuery(value)

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    debounceRef.current = setTimeout(() => {
      void searchPlaces(value)
    }, 300)
  }

  function handleSelect(suggestion: PlaceSuggestion) {
    setQuery(suggestion.description)
    setSuggestions([])
    setIsOpen(false)
    // Generate new session token for next search
    sessionTokenRef.current = crypto.randomUUID()
    onSelect(suggestion.place_id, suggestion.description)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen || suggestions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : 0
      )
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) =>
        prev > 0 ? prev - 1 : suggestions.length - 1
      )
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault()
      const selected = suggestions[selectedIndex]
      if (selected) handleSelect(selected)
    } else if (e.key === 'Escape') {
      setIsOpen(false)
    }
  }

  if (variant === 'hero') {
    return (
      <div ref={containerRef} className="relative max-w-[560px]">
        <div className="flex items-center gap-3 rounded-[14px] bg-white p-2 pl-5 shadow-[0_8px_32px_rgba(0,0,0,0.2)]">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#B0B0B0"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            id={inputId}
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => suggestions.length > 0 && setIsOpen(true)}
            placeholder={placeholder}
            className="flex-1 border-none bg-transparent text-body text-gray-900 outline-none placeholder:text-gray-300"
          />
          {isSearching && (
            <div className="size-5 shrink-0 animate-spin rounded-full border-2 border-gray-200 border-t-[var(--brand)]" />
          )}
        </div>

        {/* Suggestions dropdown */}
        {isOpen && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-xl bg-white shadow-lg">
            {suggestions.map((s, i) => (
              <button
                key={s.place_id}
                type="button"
                onClick={() => handleSelect(s)}
                className={cn(
                  'flex w-full items-center gap-2.5 px-5 py-3 text-left text-body-sm transition-colors',
                  i === selectedIndex
                    ? 'bg-[var(--brand-accent-light)] font-medium text-[var(--brand)]'
                    : 'text-gray-700 hover:bg-gray-50'
                )}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={i === selectedIndex ? 'var(--brand-accent-dark)' : '#B0B0B0'}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0"
                >
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                {s.description}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Default variant — used in booking wizard
  return (
    <div ref={containerRef} className="relative">
      <input
        id={inputId}
        type="text"
        value={query}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => suggestions.length > 0 && setIsOpen(true)}
        placeholder={placeholder}
        className={cn(
          'w-full rounded-[10px] border-[1.5px] bg-gray-50 px-3.5 py-3 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-300',
          isOpen || query
            ? 'border-[var(--brand)] border-2 bg-white'
            : 'border-gray-100'
        )}
      />

      {isSearching && (
        <div className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin rounded-full border-2 border-gray-200 border-t-[var(--brand)]" />
      )}

      {/* Suggestions dropdown */}
      {isOpen && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 flex flex-col gap-0.5 overflow-hidden rounded-lg">
          {suggestions.map((s, i) => (
            <button
              key={s.place_id}
              type="button"
              onClick={() => handleSelect(s)}
              className={cn(
                'rounded-lg px-3.5 py-3 text-left text-body-sm transition-colors',
                i === selectedIndex || i === 0
                  ? 'border border-[var(--brand-accent-dark)] bg-[var(--brand-accent-light)] font-medium text-[var(--brand)]'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              )}
            >
              {s.description}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
