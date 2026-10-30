'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Sparkles, X } from 'lucide-react'

interface Update { id: string; title: string; body: string; created_at: number }

/**
 * Floating "What's new" button, bottom-left. Each time the list opens, it fetches
 * the latest entries from the server (no cache), so newly added entries appear
 * straight away. Hidden on /admin and /portal.
 */
export function WhatsNewButton() {
  const pathname = usePathname() || ''
  const hidden = pathname.startsWith('/admin') || pathname.startsWith('/portal')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Update[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setItems(null)
    fetch(`/api/whats-new?t=${Date.now()}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error)
        setItems(Array.isArray(d.items) ? d.items : [])
      })
      .catch(() => setError('Could not load updates. Please try again.'))
  }, [open])

  if (hidden) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-5 left-5 z-[9000] inline-flex items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur hover:opacity-90"
      >
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
        What&apos;s new
      </button>

      {open && (
        <div className="fixed inset-0 z-[9995] flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label="What is new"
            onClick={e => e.stopPropagation()}
            className="w-full max-w-md max-h-[80vh] overflow-y-auto rounded-2xl border border-border bg-card text-card-foreground shadow-2xl p-5"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-semibold flex items-center gap-2"><Sparkles className="h-4 w-4 text-amber-500" /> What&apos;s new</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}
            {!error && items === null && <p className="text-sm text-muted-foreground">Loading…</p>}
            {items && items.length === 0 && <p className="text-sm text-muted-foreground">Nothing new yet.</p>}

            <ul className="space-y-4">
              {items?.map(item => (
                <li key={item.id} className="border-l-2 border-amber-500/50 pl-3">
                  <p className="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                  <p className="font-medium text-sm">{item.title}</p>
                  {item.body && <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-1">{item.body}</p>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}
