'use client'

import { useEffect, useState } from 'react'
import type { SiteBadge, SiteBadgePlacement } from '@/lib/site-badge-placements'

/**
 * Renders the enabled badges set for one location (e.g. "footer"). Badges come from
 * the database on every page load (no cache), so anything the admin adds or turns
 * off shows up without a code change.
 */
export function SiteBadges({ placement, className }: { placement: SiteBadgePlacement; className?: string }) {
  const [items, setItems] = useState<SiteBadge[]>([])

  useEffect(() => {
    let alive = true
    fetch(`/api/site-badges?t=${Date.now()}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (!alive) return
        setItems((d.items || []).filter((b: SiteBadge) => b.enabled && b.placements.includes(placement)))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [placement])

  if (items.length === 0) return null

  return (
    <div className={`flex flex-wrap items-center justify-center gap-4 ${className ?? ''}`}>
      {items.map(b => (
        <a key={b.id} href={b.href} target="_blank" rel="noopener noreferrer" title={b.title}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={b.imageUrl} alt={b.title} loading="lazy" style={{ height: '40px', width: 'auto' }} />
        </a>
      ))}
    </div>
  )
}
