'use client'

import { useState } from 'react'
import { Check, Clock, X } from 'lucide-react'
import { RETENTION_OPTIONS, SEEN_DELAY_OPTIONS, type RetentionMode } from '@/lib/live-chat-policy'

interface RetentionPickerProps {
  open: boolean
  value: RetentionMode | string
  /** Seconds to wait after a message is read, when value is "seen". 0 = instantly. */
  seenDelay?: number
  onSelect: (mode: RetentionMode, seenDelay: number) => void
  onClose: () => void
  /** Dark styling for the admin panel. */
  dark?: boolean
}

/**
 * Auto-delete picker. The setting belongs to the whole chat, and either side can
 * change it. Picking "Delete after seen" opens a list of delays in seconds. The
 * timer starts when the other side has read the message, so there is time to
 * finish reading it. Kept media and voice notes are never auto-deleted.
 */
export function RetentionPicker({ open, value, seenDelay = 0, onSelect, onClose, dark = false }: RetentionPickerProps) {
  const [showDelays, setShowDelays] = useState(value === 'seen')
  if (!open) return null

  const panel = dark ? 'bg-slate-900 border-white/10 text-white' : 'bg-background border-border text-foreground'
  const muted = dark ? 'text-white/50' : 'text-muted-foreground'
  const rowBase = dark ? 'hover:bg-white/10 border-white/10' : 'hover:bg-muted border-border'
  const chipBase = dark ? 'border-white/10 hover:bg-white/10' : 'border-border hover:bg-muted'
  const currentDelayLabel = SEEN_DELAY_OPTIONS.find(o => o.value === seenDelay)?.label ?? 'Instantly'

  return (
    <div className="fixed inset-0 z-[100010] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl border shadow-2xl p-4 ${panel}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <p className="font-semibold text-sm flex items-center gap-2">
            <Clock className="w-4 h-4" /> Auto-delete messages
          </p>
          <button onClick={onClose} className={`p-1 ${muted} hover:opacity-80`} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className={`text-xs mb-3 ${muted}`}>
          This applies to the whole chat, and either you or the other side can change it. Voice notes and
          photos or videos saved to Chat Media are never auto-deleted.
        </p>

        <div className="space-y-1.5">
          {RETENTION_OPTIONS.map(opt => {
            const selected = value === opt.value
            const isSeen = opt.value === 'seen'
            return (
              <div key={opt.value}>
                <button
                  onClick={() => {
                    if (isSeen) {
                      // Open the seconds list. The choice is made in the list below.
                      setShowDelays(v => !v)
                    } else {
                      setShowDelays(false)
                      onSelect(opt.value, 0)
                    }
                  }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border flex items-center justify-between gap-3 ${rowBase} ${selected ? (dark ? 'bg-white/10' : 'bg-muted') : ''}`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{opt.label}</span>
                    <span className={`block text-xs ${muted}`}>
                      {isSeen && selected ? `Deletes ${currentDelayLabel.toLowerCase()} after it's read` : opt.hint}
                    </span>
                  </span>
                  {selected && <Check className="w-4 h-4 shrink-0 text-emerald-500" />}
                </button>

                {isSeen && showDelays && (
                  <div className="mt-1.5 ml-2 pl-3 border-l-2 border-emerald-500/40">
                    <p className={`text-[11px] mb-1.5 ${muted}`}>Delete after it has been read:</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {SEEN_DELAY_OPTIONS.map(d => {
                        const chosen = selected && seenDelay === d.value
                        return (
                          <button
                            key={d.value}
                            onClick={() => onSelect('seen', d.value)}
                            className={`text-left text-xs px-2.5 py-2 rounded-lg border flex items-center justify-between gap-1 ${chipBase} ${chosen ? 'border-emerald-500/60' : ''}`}
                          >
                            <span>{d.label}</span>
                            {chosen && <Check className="w-3.5 h-3.5 text-emerald-500" />}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
