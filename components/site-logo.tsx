'use client'

import { useEffect, useState, type ReactNode } from 'react'

/**
 * The site logo. Shows the image set in the admin panel (Site Logo). Until one is set,
 * or while it loads, it shows `fallback` (the text logo). Nothing marks it as uploaded.
 */
export function SiteLogo({ fallback, className }: { fallback: ReactNode; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/site-logo?t=${Date.now()}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (alive) setUrl(d.url || null) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  if (!url) return <>{fallback}</>
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="Logo" className={className ?? 'h-8 w-auto block'} />
  )
}
