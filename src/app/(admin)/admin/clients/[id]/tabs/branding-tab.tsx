'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient as createBrowserClient } from '@/lib/supabase/client'
import type { Database } from '@/lib/supabase/types'
import { updateClient } from '../../actions'

type Client = Database['public']['Tables']['client']['Row']

export function BrandingTab({ client }: { client: Client }) {
  const router = useRouter()
  const supabase = createBrowserClient()
  const [primaryColour, setPrimaryColour] = useState(client.primary_colour ?? '#293F52')
  const [accentColour, setAccentColour] = useState(client.accent_colour ?? '#00E47C')
  const [logoLightUrl, setLogoLightUrl] = useState(client.logo_light_url ?? '')
  const [logoDarkUrl, setLogoDarkUrl] = useState(client.logo_dark_url ?? '')
  const [heroBannerUrl, setHeroBannerUrl] = useState(client.hero_banner_url ?? '')
  const [faviconUrl, setFaviconUrl] = useState(client.favicon_url ?? '')
  const [showPoweredBy, setShowPoweredBy] = useState(client.show_powered_by)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function handleUpload(file: File, type: 'logo-light' | 'logo-dark' | 'hero-banner' | 'favicon') {
    setUploading(type)
    const ext = file.name.split('.').pop() ?? 'png'
    // eslint-disable-next-line react-hooks/purity -- Date.now() runs inside an event handler (file-input onChange), not render
    const path = `${client.id}/${type}-${Date.now()}.${ext}`
    const { error: uploadError } = await supabase.storage
      .from('client-assets')
      .upload(path, file, { upsert: true })

    if (uploadError) {
      setError(uploadError.message)
      setUploading(null)
      return
    }

    const { data: { publicUrl } } = supabase.storage
      .from('client-assets')
      .getPublicUrl(path)

    if (type === 'logo-light') setLogoLightUrl(publicUrl)
    else if (type === 'logo-dark') setLogoDarkUrl(publicUrl)
    else if (type === 'hero-banner') setHeroBannerUrl(publicUrl)
    else setFaviconUrl(publicUrl)

    setUploading(null)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    const result = await updateClient(client.id, {
      primary_colour: primaryColour,
      accent_colour: accentColour,
      logo_light_url: logoLightUrl || null,
      logo_dark_url: logoDarkUrl || null,
      hero_banner_url: heroBannerUrl || null,
      favicon_url: faviconUrl || null,
      show_powered_by: showPoweredBy,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setSaved(true)
    router.refresh()
  }

  const inputClass = 'w-full rounded-lg border-[1.5px] border-gray-100 bg-gray-50 px-3 py-2.5 font-mono text-body-sm text-gray-900 outline-none focus:border-[#293F52] focus:bg-white'
  const sectionHeader = 'mb-3 text-2xs font-semibold uppercase tracking-wide text-gray-500'

  function UploadZone({ type, currentUrl, onClear, dark, accept = 'image/png,image/svg+xml,image/jpeg' }: { type: 'logo-light' | 'logo-dark' | 'hero-banner' | 'favicon'; currentUrl: string; onClear: () => void; dark?: boolean; accept?: string }) {
    const isUploading = uploading === type
    return currentUrl ? (
      <div className="flex items-center gap-3">
        <div className={`rounded-lg border p-2 ${dark ? 'border-gray-600 bg-[#293F52]' : 'border-gray-200 bg-white'}`}>
          <img src={currentUrl} alt={type} className="h-10 max-w-[120px] object-contain" />
        </div>
        <button type="button" onClick={onClear} className="text-2xs text-red-500 hover:underline">Remove</button>
      </div>
    ) : (
      <label className={`block cursor-pointer rounded-lg border-[1.5px] border-dashed p-6 text-center text-2xs ${dark ? 'border-gray-600 bg-[#293F52] text-gray-400' : 'border-gray-200 bg-white text-gray-400'} ${isUploading ? 'opacity-50' : 'hover:border-gray-300'}`}>
        <input
          type="file"
          accept={accept}
          className="hidden"
          disabled={isUploading}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleUpload(file, type)
          }}
        />
        {isUploading ? 'Uploading...' : 'Drop image or click to upload'}
        <br />
        <span className="text-gray-300">PNG, SVG, JPG</span>
      </label>
    )
  }

  return (
    <div className="max-w-2xl">
      {/* Colours */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className={sectionHeader}>Colours</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Primary Colour</label>
            <div className="flex items-center gap-2">
              <div className="size-8 shrink-0 rounded-md border border-gray-200" style={{ backgroundColor: primaryColour }} />
              <input type="text" value={primaryColour} onChange={(e) => setPrimaryColour(e.target.value)} className={inputClass} />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Accent Colour</label>
            <div className="flex items-center gap-2">
              <div className="size-8 shrink-0 rounded-md border border-gray-200" style={{ backgroundColor: accentColour }} />
              <input type="text" value={accentColour} onChange={(e) => setAccentColour(e.target.value)} className={inputClass} />
            </div>
          </div>
        </div>
      </div>

      {/* Logos */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className={sectionHeader}>Logos</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Logo (Light Background)</label>
            <UploadZone type="logo-light" currentUrl={logoLightUrl} onClear={() => setLogoLightUrl('')} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Logo (Dark Background)</label>
            <UploadZone type="logo-dark" currentUrl={logoDarkUrl} onClear={() => setLogoDarkUrl('')} dark />
          </div>
        </div>
      </div>

      {/* Hero Banner */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className={sectionHeader}>Hero Banner</div>
        <UploadZone type="hero-banner" currentUrl={heroBannerUrl} onClear={() => setHeroBannerUrl('')} />
        <p className="mt-2 text-2xs text-gray-400">Recommended: 1920 x 600px</p>
      </div>

      {/* Favicon */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className={sectionHeader}>Favicon</div>
        <UploadZone type="favicon" currentUrl={faviconUrl} onClear={() => setFaviconUrl('')} accept="image/png,image/svg+xml" />
        <p className="mt-2 text-2xs text-gray-400">Square, at least 512 x 512px. PNG or SVG. Shown in the browser tab on this client&rsquo;s resident pages.</p>
      </div>

      {/* Display */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <input type="checkbox" checked={showPoweredBy} onChange={(e) => setShowPoweredBy(e.target.checked)} id="show_powered_by" className="size-4 rounded border-gray-300" />
          <label htmlFor="show_powered_by" className="text-body-sm text-gray-700">Show &ldquo;Powered by VERCO&rdquo; badge</label>
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-body-sm text-red-700">{error}</div>}
      {saved && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-body-sm text-emerald-700">Changes saved.</div>}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="rounded-lg bg-[#293F52] px-5 py-2.5 text-body-sm font-semibold text-white disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save Changes'}
      </button>
    </div>
  )
}
