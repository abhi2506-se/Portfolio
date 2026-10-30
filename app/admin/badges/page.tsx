'use client'

import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { SITE_BADGE_PLACEMENTS, type SiteBadge, type SiteBadgePlacement } from '@/lib/site-badge-placements'

/** Admin: add a badge, choose where it shows, and turn it on or off. Changes are live right away. */
export default function BadgesAdminPage() {
  const [items, setItems] = useState<SiteBadge[]>([])
  const [title, setTitle] = useState('')
  const [href, setHref] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [placements, setPlacements] = useState<SiteBadgePlacement[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = () =>
    fetch(`/api/site-badges?all=1&t=${Date.now()}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => setItems(Array.isArray(d.items) ? d.items : []))
      .catch(() => setMessage('Could not load badges.'))

  useEffect(() => { load() }, [])

  const togglePlacement = (p: SiteBadgePlacement) =>
    setPlacements(cur => (cur.includes(p) ? cur.filter(x => x !== p) : [...cur, p]))

  const add = async () => {
    setBusy(true)
    setMessage(null)
    try {
      let logo = imageUrl.trim()
      if (file) {
        const form = new FormData()
        form.append('id', `badge_logo_${Date.now().toString(36)}`)
        form.append('file', file)
        const up = await fetch('/api/journey/media', { method: 'POST', body: form })
        if (!up.ok) throw new Error('Logo upload failed.')
        logo = (await up.json()).url
      }
      const res = await fetch('/api/site-badges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, href, imageUrl: logo, placements }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not save the badge.')
      setTitle(''); setHref(''); setImageUrl(''); setFile(null); setPlacements([])
      setMessage('Badge added. It is live now.')
      load()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.')
    }
    setBusy(false)
  }

  const setEnabled = async (id: string, enabled: boolean) => {
    await fetch('/api/site-badges', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    })
    load()
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this badge from the site?')) return
    await fetch(`/api/site-badges?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    load()
  }

  return (
    <div className="mx-auto max-w-2xl p-6 space-y-6">
      <h1 className="text-xl font-semibold">Site badges</h1>

      <section className="space-y-3 rounded-xl border border-white/10 p-4">
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Name, e.g. Listed on Sell With Boost" maxLength={80} className="w-full rounded-lg border px-3 py-2 text-sm bg-transparent" />
        <input value={href} onChange={e => setHref(e.target.value)} placeholder="Link, e.g. https://sellwithboost.com/..." className="w-full rounded-lg border px-3 py-2 text-sm bg-transparent" />
        <div className="space-y-1">
          <input value={imageUrl} onChange={e => setImageUrl(e.target.value)} placeholder="Logo image URL (or upload below)" className="w-full rounded-lg border px-3 py-2 text-sm bg-transparent" />
          <input type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] || null)} className="text-xs" />
        </div>
        <div className="space-y-1">
          <p className="text-xs opacity-70">Show it in:</p>
          {SITE_BADGE_PLACEMENTS.map(p => (
            <label key={p.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={placements.includes(p.value)} onChange={() => togglePlacement(p.value)} />
              {p.label}
            </label>
          ))}
        </div>
        <button onClick={add} disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Add badge'}
        </button>
        {message && <p className="text-xs opacity-80">{message}</p>}
      </section>

      <section className="space-y-2">
        {items.length === 0 && <p className="text-sm opacity-60">No badges yet.</p>}
        {items.map(b => (
          <div key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 p-3">
            <div className="flex items-center gap-3 min-w-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.imageUrl} alt="" className="h-8 w-auto shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{b.title}</p>
                <p className="text-xs opacity-60 truncate">{b.placements.join(', ')} · {b.href}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <label className="text-xs flex items-center gap-1">
                <input type="checkbox" checked={b.enabled} onChange={e => setEnabled(b.id, e.target.checked)} /> On
              </label>
              <button onClick={() => remove(b.id)} className="opacity-60 hover:opacity-100" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
