'use client'

import { useEffect, useState } from 'react'
import { Lock, Unlock, ShieldOff, X, Timer, KeyRound } from 'lucide-react'
import {
  BLOCK_TIMER_OPTIONS, MIN_CHAT_PASSWORD_LENGTH, MAX_CHAT_PASSWORD_LENGTH,
} from '@/lib/live-chat-policy'

export interface SecurityChatView {
  id: string
  user_name?: string
  security_enabled?: boolean
  security_has_password?: boolean
  block_timer_seconds?: number
  awaiting_reply_since?: number | string | null
  blocked_at?: number | string | null
  blocked_reason?: string | null
}

interface ExtraSecurityModalProps {
  open: boolean
  chat: SecurityChatView | null
  onClose: () => void
  /** Runs one live-chat action as the admin. Returns the server response. */
  onRun: (action: string, extra: Record<string, unknown>) => Promise<any>
}

function formatRemaining(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Extra Security for one chat.
 * - Turning it on requires a password. Visitors must enter it to see admin
 *   details (availability, typing, presence).
 * - Reset replaces the password and signs every visitor out of the unlock.
 * - The reply timer blocks the visitor's device if they don't answer in time.
 *   It can only be set while Extra Security is on.
 */
export function ExtraSecurityModal({ open, chat, onClose, onRun }: ExtraSecurityModalProps) {
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [showReset, setShowReset] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Reset local form state whenever a different chat is opened.
  useEffect(() => {
    setPw1(''); setPw2(''); setShowReset(false); setConfirmOff(false); setError(null); setNotice(null)
  }, [chat?.id, open])

  // Tick once a second while the countdown is visible.
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  if (!open || !chat) return null

  const enabled = !!chat.security_enabled
  const hasPassword = !!chat.security_has_password
  const timerSeconds = Number(chat.block_timer_seconds || 0)
  const since = chat.awaiting_reply_since ? Number(chat.awaiting_reply_since) : null
  const blocked = !!chat.blocked_at
  const deadline = since && timerSeconds > 0 ? since + timerSeconds * 1000 : null
  const remaining = deadline ? deadline - now : null

  const validatePasswords = (): string | null => {
    if (pw1.length < MIN_CHAT_PASSWORD_LENGTH || pw1.length > MAX_CHAT_PASSWORD_LENGTH) {
      return `Password must be ${MIN_CHAT_PASSWORD_LENGTH}–${MAX_CHAT_PASSWORD_LENGTH} characters.`
    }
    if (pw1 !== pw2) return 'The two passwords do not match.'
    return null
  }

  const run = async (action: string, extra: Record<string, unknown>, okMsg?: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const data = await onRun(action, { chatId: chat.id, ...extra })
      if (data?.error) setError(data.error)
      else if (okMsg) setNotice(okMsg)
    } catch {
      setError('Could not reach the server. Please try again.')
    }
    setBusy(false)
  }

  const turnOn = async () => {
    const v = validatePasswords()
    if (v) return setError(v)
    await run('set_extra_security', { enabled: true, password: pw1 }, 'Extra Security is on.')
    setPw1(''); setPw2('')
  }

  const resetPassword = async () => {
    const v = validatePasswords()
    if (v) return setError(v)
    await run('reset_chat_password', { password: pw1 }, 'Password changed. Visitors must enter the new one.')
    setPw1(''); setPw2(''); setShowReset(false)
  }

  const turnOff = async () => {
    await run('set_extra_security', { enabled: false }, 'Extra Security is off.')
    setConfirmOff(false)
  }

  const setTimer = (seconds: number) => {
    const label = BLOCK_TIMER_OPTIONS.find(o => o.value === seconds)?.label || ''
    return run('set_block_timer', { seconds }, seconds ? `Timer set to ${label}.` : 'Timer is off.')
  }

  const inputCls = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/40 outline-none focus:ring-2 focus:ring-violet-500/40'

  return (
    <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md max-h-[85vh] overflow-y-auto bg-slate-900 rounded-2xl border border-white/10 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <p className="font-semibold text-sm text-white flex items-center gap-2">
            <Lock className="w-4 h-4 text-violet-300" /> Extra Security{chat.user_name ? ` — ${chat.user_name}` : ''}
          </p>
          <button onClick={onClose} className="text-white/60 hover:text-white p-1" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-5 text-sm text-white/80">
          <p className="text-xs text-white/50 leading-relaxed">
            With Extra Security on, the visitor can't see your details (availability, typing, online status)
            until they enter this chat's password. You always see everything.
          </p>

          {/* ── Status + password ── */}
          {!enabled ? (
            <section className="space-y-2">
              <p className="text-white font-medium flex items-center gap-2"><ShieldOff className="w-4 h-4 text-white/50" /> Extra Security is off</p>
              <p className="text-xs text-white/50">Set a password to turn it on. It stays for this chat until you change or turn it off.</p>
              <input type="password" value={pw1} onChange={e => setPw1(e.target.value)} placeholder="New password" autoComplete="new-password" className={inputCls} />
              <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Confirm password" autoComplete="new-password" className={inputCls} />
              <button onClick={turnOn} disabled={busy || !pw1 || !pw2} className="w-full bg-gradient-to-br from-violet-600 to-blue-600 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-40">
                Turn on Extra Security
              </button>
            </section>
          ) : (
            <section className="space-y-3">
              <p className="text-white font-medium flex items-center gap-2"><Lock className="w-4 h-4 text-emerald-400" /> Extra Security is on</p>
              <p className="text-xs text-white/50">{hasPassword ? 'A password is set for this chat.' : 'No password set yet. Use Reset password below.'}</p>

              {!showReset ? (
                <div className="flex gap-2">
                  <button onClick={() => { setShowReset(true); setError(null); setNotice(null) }} className="flex-1 bg-white/10 hover:bg-white/15 text-white rounded-lg py-2 text-xs font-medium flex items-center justify-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5" /> Reset password
                  </button>
                  {!confirmOff ? (
                    <button onClick={() => setConfirmOff(true)} className="flex-1 bg-red-600/10 hover:bg-red-600/20 text-red-300 rounded-lg py-2 text-xs font-medium flex items-center justify-center gap-1.5">
                      <Unlock className="w-3.5 h-3.5" /> Turn off
                    </button>
                  ) : (
                    <button onClick={turnOff} disabled={busy} className="flex-1 bg-red-600 text-white rounded-lg py-2 text-xs font-medium disabled:opacity-40">
                      Yes, turn off
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <input type="password" value={pw1} onChange={e => setPw1(e.target.value)} placeholder="New password" autoComplete="new-password" className={inputCls} />
                  <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Confirm new password" autoComplete="new-password" className={inputCls} />
                  <div className="flex gap-2">
                    <button onClick={() => { setShowReset(false); setPw1(''); setPw2('') }} className="flex-1 bg-white/10 text-white/70 rounded-lg py-2 text-xs">Cancel</button>
                    <button onClick={resetPassword} disabled={busy || !pw1 || !pw2} className="flex-1 bg-violet-600 text-white rounded-lg py-2 text-xs font-medium disabled:opacity-40">Save new password</button>
                  </div>
                  <p className="text-[11px] text-white/40">Saving signs every visitor out of the unlock. They'll need the new password.</p>
                </div>
              )}

              {/* ── Reply timer ── */}
              <div className="pt-3 border-t border-white/10 space-y-2">
                <label className="text-white font-medium flex items-center gap-2"><Timer className="w-4 h-4 text-amber-300" /> Reply timer</label>
                <select
                  value={timerSeconds}
                  disabled={busy}
                  onChange={e => setTimer(Number(e.target.value))}
                  className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none"
                >
                  {BLOCK_TIMER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <p className="text-[11px] text-white/50 leading-relaxed">
                  The timer starts when you send a message and the visitor hasn't replied. If they don't reply in time,
                  their device is blocked from the website. The AI assistant keeps working for them. Sending more messages
                  does not restart the timer.
                </p>
                {deadline && !blocked && remaining !== null && (
                  <p className="text-xs text-amber-300">Waiting for {chat.user_name || 'the visitor'} to reply. Blocks in {formatRemaining(remaining)}.</p>
                )}
              </div>
            </section>
          )}

          {/* ── Blocked state + unblock ── */}
          {blocked && (
            <section className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 space-y-2">
              <p className="text-red-300 text-xs font-medium">This visitor's device is blocked.</p>
              {chat.blocked_reason && <p className="text-[11px] text-red-200/70">{chat.blocked_reason}</p>}
              <button onClick={() => run('unblock_visitor', {}, 'Visitor unblocked. The chat is open again.')} disabled={busy} className="w-full bg-white/10 hover:bg-white/15 text-white rounded-lg py-2 text-xs font-medium flex items-center justify-center gap-1.5 disabled:opacity-40">
                <Unlock className="w-3.5 h-3.5" /> Unblock visitor
              </button>
            </section>
          )}

          {error && <p className="text-xs text-red-400">{error}</p>}
          {notice && <p className="text-xs text-emerald-400">{notice}</p>}
        </div>
      </div>
    </div>
  )
}
