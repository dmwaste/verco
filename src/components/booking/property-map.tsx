'use client'

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

interface PropertyMapProps {
  lat: number
  lng: number
  address: string
}

export function PropertyMap({ lat, lng, address }: PropertyMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    const map = L.map(mapRef.current, {
      center: [lat, lng],
      zoom: 16,
      zoomControl: false,
      attributionControl: true,
      // Disable drag momentum. Inertia schedules a deferred requestAnimationFrame
      // that runs panBy() -> DomUtil.addClass(map._mapPane, …). If the resident
      // flicks the map and navigates away before it settles, map.remove() nulls
      // _mapPane first and the queued frame throws a TypeError on the removed map
      // (Sentry JAVASCRIPT-NEXTJS-K). Panning still works; only the coast is gone.
      inertia: false,
    })

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map)

    // Custom pin icon matching the design (navy/red teardrop)
    const pinIcon = L.divIcon({
      className: '',
      html: `
        <div style="position:relative;width:36px;height:44px">
          <div style="
            width:36px;height:36px;
            background:#E53E3E;border-radius:50% 50% 50% 0;
            transform:rotate(-45deg);
            border:3px solid white;
            box-shadow:0 3px 10px rgba(0,0,0,0.3);
          "></div>
          <div style="
            position:absolute;top:50%;left:50%;
            transform:translate(-50%,-55%) rotate(45deg);
            width:10px;height:10px;
            background:white;border-radius:50%;
          "></div>
        </div>
      `,
      iconSize: [36, 44],
      iconAnchor: [18, 44],
      popupAnchor: [0, -44],
    })

    L.marker([lat, lng], { icon: pinIcon })
      .addTo(map)
      .bindPopup(address)

    mapInstanceRef.current = map

    return () => {
      map.remove()
      mapInstanceRef.current = null
    }
  }, [lat, lng, address])

  return (
    <div
      ref={mapRef}
      className="h-[190px] w-full"
      style={{ zIndex: 0 }}
    />
  )
}
