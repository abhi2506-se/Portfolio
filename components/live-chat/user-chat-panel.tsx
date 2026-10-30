'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Send, Minus, Bot, Maximize2, Minimize2, History, Lock, Clock, MoreVertical, Phone, Video, Images, Palette, Sun, Moon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { usePresence } from '@/hooks/use-presence'
import { useLiveChatRealtime } from '@/hooks/use-live-chat-realtime'
import { useWebRTCCall } from '@/hooks/use-webrtc-call'
import { useIsMobile } from '@/hooks/use-mobile'
import { PresenceBadge } from './presence-badge'
import { MessageBubble, DateSeparator, type LiveChatMessage } from './message-bubble'
import { ReplyPreview, EndChatConfirm } from './reply-preview'
import { CallModal, CallStartButtons } from './call-modal'
import { MediaComposer, type PendingMedia } from './media-composer'
import { compressVideo, MAX_SEND_BYTES } from '@/lib/video-compress'
import { MediaViewerModal } from './media-viewer-modal'
import { TypingIndicator } from './typing-indicator'
import { VoiceRecorder, type PendingVoiceNote } from './voice-recorder'
import { EmojiPicker, EmojiPickerButton } from './emoji-picker'
import { WallpaperPicker, WallpaperPickerButton, LiveWallpaperOverlay } from './wallpaper-picker'
import { ChatMediaGallery, ChatMediaButton, type ChatMediaItem } from './chat-media-gallery'
import { RetentionPicker } from './retention-picker'
import type { RetentionMode } from '@/lib/live-chat-policy'
import { getWallpaper, wallpaperCssVars } from '@/lib/live-chat-wallpapers'
import { chatDayKey, formatDateSeparator } from '@/lib/chat-format'
import { mergeIncomingMessage, mergeIncomingMessages } from '@/lib/live-chat-merge'

function fmtTime(ts: any) {
  const n = typeof ts === 'string' ? parseInt(ts, 10) : Number(ts)
  const d = new Date(n)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
}

function newClientId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

/** Small ticking countdown shown atop the archive view: "Access expires in 8m 12s". */
function ArchiveExpiryNotice({ expiresAt }: { expiresAt: number }) {
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, expiresAt - Date.now()))
  useEffect(() => {
    const t = setInterval(() => setRemainingMs(Math.max(0, expiresAt - Date.now())), 1000)
    return () => clearInterval(t)
  }, [expiresAt])
  const mins = Math.floor(remainingMs / 60000)
  const secs = Math.floor((remainingMs % 60000) / 1000)
  return (
    <div className="mx-3 mb-2 text-center text-[11px] text-amber-500 bg-amber-500/10 rounded-lg py-1.5">
      🔓 Admin's approval is valid for a little longer — expires in {mins}m {secs}s
    </div>
  )
}

/**
 * Light and dark palettes for the visitor chat. They're scoped to the chat's root
 * element, so the site's own theme is never changed. The chat is dark by default.
 */
const VISITOR_THEME_CSS = `
.visitor-theme-dark { color-scheme: dark; --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0); --card: oklch(0.205 0 0); --card-foreground: oklch(0.985 0 0); --popover: oklch(0.205 0 0); --popover-foreground: oklch(0.985 0 0); --muted: oklch(0.269 0 0); --muted-foreground: oklch(0.708 0 0); --border: oklch(0.269 0 0); --input: oklch(0.269 0 0); }
.visitor-theme-light { color-scheme: light; --background: oklch(1 0 0); --foreground: oklch(0.145 0 0); --card: oklch(1 0 0); --card-foreground: oklch(0.145 0 0); --popover: oklch(1 0 0); --popover-foreground: oklch(0.145 0 0); --muted: oklch(0.97 0 0); --muted-foreground: oklch(0.556 0 0); --border: oklch(0.922 0 0); --input: oklch(0.922 0 0); }
`

function HeaderMenuItem({ icon: Icon, label, onClick, disabled, danger }: {
  icon: LucideIcon; label: string; onClick: () => void; disabled?: boolean; danger?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/10 disabled:opacity-40 ${danger ? 'text-red-300' : 'text-white/90'}`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {label}
    </button>
  )
}

/** Visible countdown shown to the visitor while the admin's reply timer runs. */
function ReplyCountdown({ deadline }: { deadline: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()))
  useEffect(() => {
    const t = setInterval(() => setRemaining(Math.max(0, deadline - Date.now())), 500)
    return () => clearInterval(t)
  }, [deadline])
  const total = Math.ceil(remaining / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return (
    <div className="mx-4 mt-2 text-center text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-lg py-2 px-3 flex-shrink-0">
      ⏱️ Please reply within <strong className="tabular-nums">{mins}:{String(secs).padStart(2, '0')}</strong>,
      or this chat will close and access to the website will be restricted on this device.
    </div>
  )
}

interface UserChatPanelProps {
  chatId: string
  onClose: () => void
  onEnded?: () => void
  /** Hide (minimize) the chat without closing/ending it — same as onClose,
   *  exposed separately so callers can label it distinctly in the UI. */
  onMinimize?: () => void
  /**
   * Optionally supply a `useWebRTCCall` instance owned by a persistent
   * ancestor (e.g. the root AIAssistant component) instead of letting this
   * panel create its own. This is what lets an in-progress call survive the
   * user closing/minimizing the chat widget or navigating elsewhere in the
   * app — the hook (and the peer connection it holds) keeps living at the
   * ancestor's level even while this panel unmounts. When provided, this
   * panel will NOT render its own <CallModal/> (the ancestor is expected to
   * render one globally) to avoid mounting the call UI twice.
   */
  externalCall?: ReturnType<typeof useWebRTCCall>
  /**
   * Called (with the channel's `sendCallSignal` function) once this panel's
   * single Realtime subscription is live, and again with a no-op on
   * unmount. Lets a parent that owns an `externalCall` instance send
   * WebRTC signaling through THIS panel's channel instead of opening a
   * second subscription to the same chat topic (which is unreliable — see
   * the comment in ai-assistant.tsx for why).
   */
  onCallSignalChannelReady?: (send: (payload: any) => void) => void
  /**
   * When true, this panel renders full-screen (via a `document.body` portal,
   * exactly like the mobile behavior below) regardless of device — this is
   * how live chat opens by default on PC as well as mobile. When false, it
   * renders inline, sized by its parent (the small assistant widget box).
   * Mobile always renders full-screen either way.
   */
  forceFullscreen?: boolean
  /** Lets the header's maximize/minimize button flip `forceFullscreen` on desktop. */
  onToggleFullscreen?: () => void
}

/** Drop-in replacement for the old inline live-chat block inside the AI assistant widget. */
export function UserChatPanel({ chatId, onClose, onEnded, onMinimize, externalCall, onCallSignalChannelReady, forceFullscreen, onToggleFullscreen }: UserChatPanelProps) {
  const [messages, setMessages] = useState<LiveChatMessage[]>([])
  const [input, setInput] = useState('')
  const [adminTyping, setAdminTyping] = useState(false)
  const [replyTarget, setReplyTarget] = useState<LiveChatMessage | null>(null)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [ended, setEnded] = useState<'user' | 'admin' | 'system' | null>(null)
  const [endReason, setEndReason] = useState<string | null>(null)
  const [historyHidden, setHistoryHidden] = useState<{ hidden: boolean; hiddenAt: number | null }>({ hidden: false, hiddenAt: null })
  const [wallpaperId, setWallpaperId] = useState('default')
  const [wallpaperPickerOpen, setWallpaperPickerOpen] = useState(false)
  // ── Extra Security (admin details hidden until the chat password is entered) ──
  const [securityEnabled, setSecurityEnabled] = useState(false)
  const [securityLocked, setSecurityLocked] = useState(false)
  // Epoch ms when the visitor's reply window closes (null = no countdown running)
  const [replyDeadline, setReplyDeadline] = useState<number | null>(null)
  const [unlockPw, setUnlockPw] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  // ── Auto-delete for this chat (either side can change it) ──
  const [retention, setRetention] = useState<RetentionMode>('never')
  const [retentionSeenDelay, setRetentionSeenDelay] = useState(0)
  const [retentionOpen, setRetentionOpen] = useState(false)
  // Tells the AI assistant about a block only once per panel.
  const blockedNotified = useRef(false)
  const [mediaGalleryOpen, setMediaGalleryOpen] = useState(false)
  // Options menu (the ⋮ button in the header)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  // Admin's Journey profile photo, shown as the chat avatar when the real admin is handling the chat
  const [adminPhoto, setAdminPhoto] = useState<string | null>(null)
  useEffect(() => {
    fetch('/api/journey/profile', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => setAdminPhoto(d.mainProfileUrl || d.journeyProfileUrl || null))
      .catch(() => {})
  }, [])
  // Visitor's own light/dark choice. Stored separately from the admin's.
  const [visitorTheme, setVisitorTheme] = useState<'dark' | 'light'>('dark')
  useEffect(() => {
    try {
      const saved = localStorage.getItem('visitor-chat-theme')
      if (saved === 'light' || saved === 'dark') setVisitorTheme(saved)
    } catch {}
  }, [])
  const toggleVisitorTheme = () => setVisitorTheme(t => {
    const next = t === 'light' ? 'dark' : 'light'
    try { localStorage.setItem('visitor-chat-theme', next) } catch {}
    return next
  })
  // Runs a menu action and closes the menu first.
  const fromMenu = (fn: () => void) => () => { setHeaderMenuOpen(false); fn() }
  const [uploading, setUploading] = useState(false)
  // Who is handling the chat right now (a co-admin while the real admin is away)
  const [agentName, setAgentName] = useState('Abhishek')
  const [agentIsCoAdmin, setAgentIsCoAdmin] = useState(false)
  // Video compression progress (0-100), null when not compressing
  const [compressPct, setCompressPct] = useState<number | null>(null)
  // Shown under the composer when a file can't be sent. Clears after 6 seconds.
  const [mediaError, setMediaError] = useState<string | null>(null)
  useEffect(() => {
    if (!mediaError) return
    const t = setTimeout(() => setMediaError(null), 6000)
    return () => clearTimeout(t)
  }, [mediaError])
  const [adminOnline, setAdminOnline] = useState(true) // optimistic until first poll lands
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [voicePhase, setVoicePhase] = useState<'idle' | 'recording' | 'preview'>('idle')
  const emojiBtnRef = useRef<HTMLButtonElement>(null)
  const [viewer, setViewer] = useState<{ open: boolean; loading: boolean; error: string | null; url: string | null; mediaType: 'image' | 'video' | null; viewsRemaining: number | null }>(
    { open: false, loading: false, error: null, url: null, mediaType: null, viewsRemaining: null }
  )
  const isMobile = useIsMobile()
  const [mounted, setMounted] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const adminTypingExpiry = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Archive (older messages beyond the latest 20 shown live) ───────────
  const [hasArchive, setHasArchive] = useState(false)
  const [archiveStatus, setArchiveStatus] = useState<{ requested: boolean; granted: boolean; expiresAt?: number | null }>({ requested: false, granted: false, expiresAt: null })
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveMessages, setArchiveMessages] = useState<LiveChatMessage[]>([])
  const [archiveLoading, setArchiveLoading] = useState(false)

  // The parent chat widget animates with a CSS transform, which creates a new
  // containing block for `position: fixed` descendants — that's what was
  // trapping the "full screen on mobile" panel inside the small widget box.
  // Rendering through a portal attaches this panel directly to <body>, so
  // `fixed inset-0` below is relative to the real viewport again.
  useEffect(() => { setMounted(true) }, [])

  const { presence, setPresenceFromBroadcast } = usePresence(chatId, 'user')

  const messageMap = useRef<Map<string, LiveChatMessage>>(new Map())
  const syncMessages = useCallback((updater: (map: Map<string, LiveChatMessage>) => void) => {
    updater(messageMap.current)
    setMessages(Array.from(messageMap.current.values()).sort((a, b) => Number(a.created_at) - Number(b.created_at)))
  }, [])

  // ── Initial load + polling fallback ─────────────────────────────────────
  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const res = await fetch(`/api/live-chat?chatId=${encodeURIComponent(chatId)}`)
        if (res.ok && !stop) {
          const data = await res.json()
          const hidden = data.historyHidden?.hidden ? { hidden: true, hiddenAt: Number(data.historyHidden.hiddenAt) || null } : { hidden: false, hiddenAt: null }
          if (hidden.hidden) {
            // Admin cleared history from this point back — drop any older
            // messages we already had cached locally from before that.
            syncMessages(map => {
              for (const [id, m] of map) if (Number(m.created_at) <= (hidden.hiddenAt || 0)) map.delete(id)
              mergeIncomingMessages(map, data.messages || [])
            })
          } else {
            syncMessages(map => mergeIncomingMessages(map, data.messages || []))
          }
          setHistoryHidden(hidden)
          setAdminTyping(!!data.adminTyping)
          setAdminOnline(data.adminOnline !== false)
          setHasArchive(!!data.hasArchive)
          if (data.wallpaperId) setWallpaperId(data.wallpaperId)
          setSecurityEnabled(!!data.securityEnabled)
          setSecurityLocked(!!data.securityLocked)
          setReplyDeadline(data.replyTimerRemainingMs == null ? null : Date.now() + Number(data.replyTimerRemainingMs))
          if (data.retention) setRetention(data.retention as RetentionMode)
          setRetentionSeenDelay(Number(data.retentionSeenDelay || 0))
          setAgentName(data.agentName || 'Abhishek')
          setAgentIsCoAdmin(!!data.agentIsCoAdmin)
          if (Array.isArray(data.purgedIds) && data.purgedIds.length) {
            const gone = new Set<string>(data.purgedIds)
            syncMessages(map => { for (const id of gone) map.delete(id) })
          }
          if (data.blocked && !blockedNotified.current) {
            blockedNotified.current = true
            window.dispatchEvent(new CustomEvent('lc-blocked'))
          }
          if (data.archiveStatus) setArchiveStatus({ requested: !!data.archiveStatus.requested, granted: !!data.archiveStatus.granted, expiresAt: data.archiveStatus.expiresAt || null })
          if (data.status === 'closed' && !ended) { setEnded(data.endedBy || 'admin'); setEndReason(data.endReason || null) }
        }
      } catch {}
    }
    load()
    const interval = setInterval(load, 4000)
    return () => { stop = true; clearInterval(interval) }
  }, [chatId, syncMessages, ended])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, adminTyping])

  // Mark admin messages delivered/read while this panel is open.
  useEffect(() => {
    const mark = () => {
      fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mark_delivered', chatId }) })
        .then(r => { if (!r.ok) console.error('[live-chat] mark_delivered failed', r.status) })
        .catch(err => console.error('[live-chat] mark_delivered error', err))
      if (document.visibilityState === 'visible') {
        fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mark_read', chatId }) })
          .then(r => { if (!r.ok) console.error('[live-chat] mark_read failed', r.status) })
          .catch(err => console.error('[live-chat] mark_read error', err))
      }
    }
    mark()
    const t = setInterval(mark, 5000)
    return () => clearInterval(t)
  }, [chatId, messages.length])

  // ── Realtime ─────────────────────────────────────────────────────────────
  const { sendCallSignal } = useLiveChatRealtime(chatId, {
    onNewMessage: (m) => {
      // Like WhatsApp: the typing bubble disappears the moment their message lands.
      if (m.role === 'admin') { setAdminTyping(false); if (adminTypingExpiry.current) clearTimeout(adminTypingExpiry.current) }
      syncMessages(map => mergeIncomingMessage(map, m))
    },
    onMessageUpdated: (m) => syncMessages(map => mergeIncomingMessage(map, m)),
    onReceiptsUpdated: (ids, status) => syncMessages(map => { for (const id of ids) { const ex = map.get(id); if (ex) map.set(id, { ...ex, status }) } }),
    onPresence: (role, info) => setPresenceFromBroadcast(role, info as any),
    onTyping: (role) => {
      if (role !== 'admin') return
      setAdminTyping(true)
      // Reset (not stack) the expiry so the bubble doesn't flicker while typing continues.
      if (adminTypingExpiry.current) clearTimeout(adminTypingExpiry.current)
      adminTypingExpiry.current = setTimeout(() => setAdminTyping(false), 4500)
    },
    onChatEnded: (by, reason) => { setEnded(by); setEndReason(reason || null) },
    onCallSignal: (payload) => call.handleSignal(payload),
    onWallpaperChanged: (payload) => { if (payload.wallpaperId) setWallpaperId(payload.wallpaperId) },
    onChatDeleted: () => { setEnded('admin'); setEndReason('This conversation was removed by Admin.') },
    onMessagesDeleted: (ids) => syncMessages(map => { for (const id of ids) map.delete(id) }),
    onRetentionChanged: (payload) => {
      if (payload.retention) setRetention(payload.retention as RetentionMode)
      setRetentionSeenDelay(Number(payload.seenDelay || 0))
    },
    onHistoryHidden: (payload) => {
      setHistoryHidden({ hidden: payload.hidden, hiddenAt: payload.hiddenAt })
      if (payload.hidden) {
        syncMessages(map => { for (const [id, m] of map) if (Number(m.created_at) <= (payload.hiddenAt || 0)) map.delete(id) })
        setHasArchive(false)
      }
    },
  })

  const logCall = useCallback(async (action: 'start' | 'end', data: any) => {
    const res = await fetch('/api/live-chat/call-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) })
    return res.json()
  }, [])

  // Let a parent that owns `externalCall` route outgoing WebRTC signaling
  // through THIS panel's one-and-only Realtime subscription (see the prop
  // doc comment above) instead of opening its own second subscription.
  useEffect(() => {
    onCallSignalChannelReady?.(sendCallSignal)
    return () => onCallSignalChannelReady?.(() => {
      console.error('[live-chat] Cannot send call signal — chat panel unmounted, channel not connected.')
    })
  }, [sendCallSignal, onCallSignalChannelReady])

  // Falls back to an internally-owned call hook only if the parent didn't
  // supply one — see the `externalCall` doc comment above.
  const ownCall = useWebRTCCall({ chatId, role: 'user', onSignal: sendCallSignal, logCall })
  const call = externalCall || ownCall

  // ── Send / edit / unsend ────────────────────────────────────────────────
  const sendMessage = async () => {
    const content = input.trim()
    if (!content) return
    setInput('')
    setReplyDeadline(null)
    const clientId = newClientId()
    const optimistic: LiveChatMessage = {
      id: clientId, chat_id: chatId, role: 'user', content, created_at: Date.now(),
      client_id: clientId, reply_to_id: replyTarget?.id || null, status: 'sent', _pending: true,
    }
    syncMessages(map => map.set(clientId, optimistic))
    const replyToId = replyTarget?.id
    setReplyTarget(null)
    try {
      const res = await fetch('/api/live-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'message', chatId, content, clientId, replyToId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => null)
        if (d?.blocked) window.dispatchEvent(new CustomEvent('lc-blocked'))
        throw new Error()
      }
      const data = await res.json()
      syncMessages(map => { map.delete(clientId); if (data.message) map.set(data.message.id, data.message) })
    } catch {
      syncMessages(map => map.set(clientId, { ...optimistic, _pending: false, status: 'failed' }))
    }
  }

  // Enter the chat password to reveal admin details on this device.
  const unlockChat = async () => {
    if (!unlockPw.trim() || unlocking) return
    setUnlocking(true)
    setUnlockError(null)
    try {
      const res = await fetch('/api/live-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify_chat_password', chatId, password: unlockPw }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        setSecurityLocked(false)
        setUnlockPw('')
      } else {
        setUnlockError(data.error || 'Could not unlock. Please try again.')
      }
    } catch {
      setUnlockError('Could not reach the server. Please try again.')
    }
    setUnlocking(false)
  }

  // Auto-delete: the visitor picks a setting for the whole chat.
  const changeRetention = async (mode: RetentionMode, seenDelay: number) => {
    setRetention(mode)
    setRetentionSeenDelay(mode === 'seen' ? seenDelay : 0)
    setRetentionOpen(false)
    try {
      await fetch('/api/live-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_retention', chatId, retention: mode, seenDelay }),
      })
    } catch {}
  }

  const changeWallpaper = async (id: string) => {
    setWallpaperId(id) // optimistic
    setWallpaperPickerOpen(false)
    try {
      await fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set_wallpaper', chatId, wallpaperId: id }) })
    } catch {}
  }

  const retryMessage = (m: LiveChatMessage) => {
    setInput(m.content)
    syncMessages(map => map.delete(m.id))
  }

  const editMessage = async (m: LiveChatMessage, newContent: string) => {
    if (!newContent || newContent === m.content) return
    syncMessages(map => map.set(m.id, { ...m, content: newContent, edited_at: Date.now() }))
    await fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'edit_message', chatId, messageId: m.id, content: newContent }) }).catch(() => {})
  }

  const unsendMessage = async (m: LiveChatMessage) => {
    syncMessages(map => map.set(m.id, { ...m, unsent_at: Date.now(), content: '' }))
    await fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'unsend_message', chatId, messageId: m.id }) }).catch(() => {})
  }

  const handleInputChange = (val: string) => {
    setInput(val)
    if (typingTimeout.current) return
    fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'typing', chatId, role: 'user' }) }).catch(() => {})
    typingTimeout.current = setTimeout(() => { typingTimeout.current = null }, 3000)
  }

  const jumpToReply = (id: string) => {
    document.getElementById(`lc-msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const doEndChat = async (reason?: string) => {
    setConfirmEnd(false)
    if (call.state !== 'idle') call.endCall()
    await fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'end_chat', chatId, reason }) }).catch(() => {})
    setEnded('user')
    setEndReason(reason || null)
    onEnded?.()
  }

  // ── View-once media: send ────────────────────────────────────────────
  const handleMediaSelect = async (media: PendingMedia) => {
    // When the user picked this file. The message keeps this time, even if upload and compression take a while.
    const pickedAt = Date.now()
    if (uploading || ended) return
    setUploading(true)
    const viewMode = media.viewMode || 'twice'
    const mediaKeep = viewMode === 'keep'
    const mediaViewLimit = viewMode === 'once' ? 1 : 2
    try {
      // Videos are compressed in the browser before upload.
      let file: File = media.file instanceof File ? media.file : new File([media.file], media.filename, { type: media.file.type })
      if (media.mediaType === 'video') {
        setCompressPct(0)
        try { file = await compressVideo(media.file, media.filename, p => setCompressPct(Math.round(p * 100))) }
        finally { setCompressPct(null) }
      }
      if (file.size > MAX_SEND_BYTES) throw new Error('This video is too long to send, even after compression. Please send a shorter clip.')
      const res = await fetch(`/api/live-chat/media-upload?chatId=${encodeURIComponent(chatId)}&filename=${encodeURIComponent(file.name)}&type=${media.mediaType}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || (media.mediaType === 'video' ? 'video/webm' : 'image/jpeg') },
        body: file,
      })
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data.error || 'Upload failed')

      const clientId = newClientId()
      const optimistic: LiveChatMessage = {
        id: clientId, chat_id: chatId, role: 'user', content: '', created_at: Date.now(),
        client_id: clientId, status: 'sent', _pending: true,
        media_url: data.url, media_type: media.mediaType, media_view_limit: mediaViewLimit, media_view_count: 0, media_locked: false, media_keep: mediaKeep, is_sender: true,
      }
      syncMessages(map => map.set(clientId, optimistic))

      const sendRes = await fetch('/api/live-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'message', chatId, content: '', clientId, mediaUrl: data.url, mediaType: media.mediaType, mediaViewLimit, mediaKeep, sentAt: pickedAt }),
      })
      const sendData = await sendRes.json()
      syncMessages(map => { map.delete(clientId); if (sendData.message) map.set(sendData.message.id, { ...sendData.message, is_sender: true }) })
    } catch (err) {
      setMediaError(err instanceof Error ? err.message : 'Could not send this file. Please try again.')
      // Silent — the optimistic bubble (if any) simply stays as a failed send.
    } finally {
      setUploading(false)
    }
  }

  // ── Voice note: upload + send ──────────────────────────────────────────
  const handleVoiceSend = async (note: PendingVoiceNote) => {
    if (uploading || ended) return
    setUploading(true)
    try {
      const ext = note.file.type.includes('mp4') ? 'm4a' : 'webm'
      const filename = `voice_${Date.now()}.${ext}`
      const res = await fetch(`/api/live-chat/media-upload?chatId=${encodeURIComponent(chatId)}&filename=${encodeURIComponent(filename)}&type=audio`, {
        method: 'POST', headers: { 'Content-Type': note.file.type || 'audio/webm' }, body: note.file,
      })
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data.error || 'Upload failed')

      const clientId = newClientId()
      const optimistic: LiveChatMessage = {
        id: clientId, chat_id: chatId, role: 'user', content: '', created_at: Date.now(),
        client_id: clientId, status: 'sent', _pending: true,
        media_url: data.url, media_type: 'audio', duration_ms: note.durationMs, is_sender: true,
      }
      syncMessages(map => map.set(clientId, optimistic))

      const sendRes = await fetch('/api/live-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'message', chatId, content: '', clientId, mediaUrl: data.url, mediaType: 'audio', durationMs: note.durationMs }),
      })
      const sendData = await sendRes.json()
      syncMessages(map => { map.delete(clientId); if (sendData.message) map.set(sendData.message.id, { ...sendData.message, is_sender: true }) })
    } catch {
      // Silent — matches handleMediaSelect's failure behavior.
    } finally {
      setUploading(false)
    }
  }

  // ── GIF (already hosted externally — no upload step needed) ───────────
  const handlePickGif = async (url: string) => {
    setEmojiOpen(false)
    if (ended) return
    const clientId = newClientId()
    const optimistic: LiveChatMessage = {
      id: clientId, chat_id: chatId, role: 'user', content: '', created_at: Date.now(),
      client_id: clientId, status: 'sent', _pending: true, media_url: url, media_type: 'gif', is_sender: true,
    }
    syncMessages(map => map.set(clientId, optimistic))
    try {
      const res = await fetch('/api/live-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'message', chatId, content: '', clientId, mediaUrl: url, mediaType: 'gif' }),
      })
      const data = await res.json()
      syncMessages(map => { map.delete(clientId); if (data.message) map.set(data.message.id, { ...data.message, is_sender: true }) })
    } catch {
      syncMessages(map => map.set(clientId, { ...optimistic, _pending: false, status: 'failed' }))
    }
  }

  // ── Sticker (rendered as a naked full-size emoji message) ──────────────
  const handlePickSticker = (sticker: string) => {
    setEmojiOpen(false)
    if (ended) return
    setInput('')
    const clientId = newClientId()
    const optimistic: LiveChatMessage = { id: clientId, chat_id: chatId, role: 'user', content: sticker, created_at: Date.now(), client_id: clientId, status: 'sent', _pending: true }
    syncMessages(map => map.set(clientId, optimistic))
    fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'message', chatId, content: sticker, clientId }) })
      .then(r => r.json())
      .then(data => syncMessages(map => { map.delete(clientId); if (data.message) map.set(data.message.id, data.message) }))
      .catch(() => syncMessages(map => map.set(clientId, { ...optimistic, _pending: false, status: 'failed' })))
  }

  const handleReact = async (m: LiveChatMessage, emoji: string) => {
    syncMessages(map => { const ex = map.get(m.id); if (ex) map.set(m.id, { ...ex, user_reaction: ex.user_reaction === emoji ? null : emoji }) })
    await fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle_reaction', chatId, messageId: m.id, emoji }) }).catch(() => {})
  }

  const handleStar = async (m: LiveChatMessage) => {
    syncMessages(map => { const ex = map.get(m.id); if (ex) map.set(m.id, { ...ex, starred_by_user: !ex.starred_by_user }) })
    await fetch('/api/live-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'toggle_star', chatId, messageId: m.id }) }).catch(() => {})
  }

  // ── View-once media: open full-screen viewer ────────────────────────
  const openMedia = async (m: LiveChatMessage) => {
    setViewer({ open: true, loading: true, error: null, url: null, mediaType: (m.media_type === 'video' ? 'video' : 'image'), viewsRemaining: null })
    try {
      const res = await fetch('/api/live-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'view_media', chatId, messageId: m.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        setViewer(v => ({ ...v, loading: false, error: data.error || 'This media is no longer available.' }))
        return
      }
      setViewer({ open: true, loading: false, error: null, url: data.url, mediaType: data.mediaType, viewsRemaining: data.viewsRemaining })
      if (!m.is_sender) {
        syncMessages(map => { const ex = map.get(m.id); if (ex) map.set(m.id, { ...ex, media_view_count: (ex.media_view_count ?? 0) + 1, media_locked: !!data.locked }) })
      }
    } catch {
      setViewer(v => ({ ...v, loading: false, error: 'Could not load media. Please try again.' }))
    }
  }
  const closeMediaViewer = () => setViewer(v => ({ ...v, open: false, url: null }))

  // ── Chat Media gallery: open an item directly (already unmasked, so no
  //    view_media round-trip / view-consumption is needed for these). ────
  const openGalleryItem = (item: { media_url: string; media_type: 'image' | 'video' | 'audio' }) => {
    if (item.media_type === 'audio') return
    setMediaGalleryOpen(false)
    setViewer({ open: true, loading: false, error: null, url: item.media_url, mediaType: item.media_type, viewsRemaining: null })
  }

  // ── Archive: request access, or fetch it once approved ──────────────────
  const openArchive = useCallback(async () => {
    setArchiveOpen(true)
    if (archiveStatus.granted) {
      setArchiveLoading(true)
      try {
        const res = await fetch('/api/live-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_archive', chatId }),
        })
        const data = await res.json()
        if (res.ok) setArchiveMessages(data.messages || [])
      } catch {}
      setArchiveLoading(false)
    } else if (!archiveStatus.requested) {
      try {
        const res = await fetch('/api/live-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'request_archive', chatId }),
        })
        const data = await res.json()
        if (res.ok) setArchiveStatus({ requested: !!data.requested, granted: !!data.granted })
      } catch {}
    }
  }, [chatId, archiveStatus])

  // Poll archive status while the archive modal is open — auto-loads once
  // the admin approves, and also detects the 10-minute grant expiring so
  // the visitor is asked to request access again rather than silently
  // being shown a stale "granted" state.
  useEffect(() => {
    if (!archiveOpen) return
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/live-chat?chatId=${encodeURIComponent(chatId)}`)
        if (!res.ok) return
        const data = await res.json()
        if (data.archiveStatus) {
          setArchiveStatus({ requested: !!data.archiveStatus.requested, granted: !!data.archiveStatus.granted, expiresAt: data.archiveStatus.expiresAt || null })
          if (!data.archiveStatus.granted) setArchiveMessages([]) // grant expired (or was revoked) — clear stale data
        }
      } catch {}
    }, 4000)
    return () => clearInterval(poll)
  }, [archiveOpen, chatId])

  // Once granted while the modal is open, fetch the full history automatically.
  useEffect(() => {
    if (!archiveOpen || !archiveStatus.granted || archiveMessages.length) return
    (async () => {
      setArchiveLoading(true)
      try {
        const res = await fetch('/api/live-chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get_archive', chatId }),
        })
        const data = await res.json()
        if (res.ok) setArchiveMessages(data.messages || [])
      } catch {}
      setArchiveLoading(false)
    })()
  }, [archiveOpen, archiveStatus.granted, archiveMessages.length, chatId])

  // Only the latest 20 messages show in the live view — the rest live in the archive.
  const visibleMessages = messages.slice(-20)
  const activeWallpaper = getWallpaper(wallpaperId)

  const fullscreen = isMobile || !!forceFullscreen
  const panel = (
    <div
      className={`flex flex-col h-full bg-background text-foreground visitor-theme-${visitorTheme} ${fullscreen ? 'fixed inset-0 z-[100000]' : ''}`}
      style={wallpaperCssVars(activeWallpaper) as any}
    >
      <style>{VISITOR_THEME_CSS}</style>
      <div className="flex items-center justify-between gap-2 px-3 py-3 flex-shrink-0 bg-gradient-to-r from-blue-600 to-cyan-500 text-white shadow-sm">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="relative shrink-0">
            {/* Real admin: the Journey profile photo. Co-admin: their first letter. Locked: a bot icon. */}
            {!securityLocked && agentIsCoAdmin ? (
              <div className="w-10 h-10 rounded-full bg-white/25 backdrop-blur flex items-center justify-center ring-2 ring-white/30 text-white font-semibold">
                {(agentName || 'C').trim().charAt(0).toUpperCase()}
              </div>
            ) : !securityLocked && adminPhoto ? (
              <img src={adminPhoto} alt="" className="w-10 h-10 rounded-full object-cover ring-2 ring-white/30" />
            ) : (
              <div className="w-10 h-10 rounded-full bg-white/15 backdrop-blur flex items-center justify-center ring-2 ring-white/30">
                <Bot className="w-5 h-5 text-white" />
              </div>
            )}
            <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-blue-600 ${!securityLocked && presence.admin?.status === 'online' ? 'bg-emerald-400' : 'bg-slate-300'}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-white text-sm truncate">{securityLocked ? 'Admin' : agentName}</p>
            <div className="[&_span]:!text-white/80 text-xs truncate">
              {!securityLocked && !agentIsCoAdmin && <PresenceBadge info={presence.admin} />}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <div className="relative">
            <button
              type="button"
              onClick={() => setHeaderMenuOpen(v => !v)}
              aria-label="Chat options"
              aria-expanded={headerMenuOpen}
              className="text-white/90 hover:text-white p-2 rounded-full hover:bg-white/10"
            >
              <MoreVertical className="w-5 h-5" />
            </button>
            {headerMenuOpen && (
              <>
                <div className="fixed inset-0 z-[99]" onClick={() => setHeaderMenuOpen(false)} />
                <div className="absolute right-0 top-11 z-[100] w-60 rounded-xl border border-white/10 bg-slate-900 text-white shadow-2xl py-1 text-sm">
                  <HeaderMenuItem icon={Phone} label="Voice call" disabled={!!ended} onClick={fromMenu(() => call.startCall('audio'))} />
                  <HeaderMenuItem icon={Video} label="Video call" disabled={!!ended} onClick={fromMenu(() => call.startCall('video'))} />
                  <HeaderMenuItem icon={Images} label="Chat media" onClick={fromMenu(() => setMediaGalleryOpen(true))} />
                  <HeaderMenuItem icon={Palette} label="Wallpaper" onClick={fromMenu(() => setWallpaperPickerOpen(true))} />
                  <HeaderMenuItem icon={History} label="Chat history" onClick={fromMenu(() => openArchive())} />
                  <HeaderMenuItem icon={Clock} label="Auto-delete messages" onClick={fromMenu(() => setRetentionOpen(true))} />
                  <HeaderMenuItem
                    icon={visitorTheme === 'light' ? Moon : Sun}
                    label={visitorTheme === 'light' ? 'Dark mode' : 'Light mode'}
                    onClick={fromMenu(toggleVisitorTheme)}
                  />
                  {!isMobile && onToggleFullscreen && (
                    <HeaderMenuItem
                      icon={forceFullscreen ? Minimize2 : Maximize2}
                      label={forceFullscreen ? 'Shrink chat window' : 'Expand to full screen'}
                      onClick={fromMenu(onToggleFullscreen)}
                    />
                  )}
                  <HeaderMenuItem icon={Lock} label="Lock settings (PIN, auto-lock)" onClick={fromMenu(() => window.dispatchEvent(new CustomEvent('vlock-open-settings')))} />
                  <HeaderMenuItem icon={Minus} label="Hide chat (stays active)" onClick={fromMenu(onMinimize || onClose)} />
                  <div className="my-1 border-t border-white/10" />
                  <HeaderMenuItem icon={X} label="End chat" danger onClick={fromMenu(() => setConfirmEnd(true))} />
                </div>
              </>
            )}
          </div>
          <button onClick={onClose} title="Close" className="text-white/80 hover:text-white p-2 rounded-full hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {ended && (
        <div className="mx-4 mt-2 text-center text-xs text-muted-foreground bg-muted rounded-lg py-2 flex-shrink-0 px-3">
          <p>Chat ended{ended === 'admin' ? ' by Admin' : ''}.</p>
          {endReason && <p className="mt-0.5 italic">"{endReason}"</p>}
        </div>
      )}

      {historyHidden.hidden && !ended && (
        <div className="mx-4 mt-2 text-center text-xs text-muted-foreground bg-muted rounded-lg py-2 flex-shrink-0">
          🔒 Earlier messages in this chat were cleared by Admin
        </div>
      )}

      {!ended && !adminOnline && (
        <div className="mx-4 mt-2 text-center text-xs text-red-400 bg-red-500/10 rounded-lg py-2 flex-shrink-0 px-3">
          🔴 Abhishek is currently unavailable — leave a message (text or voice note) and he'll get back to you.
        </div>
      )}

      {replyDeadline && !ended && <ReplyCountdown deadline={replyDeadline} />}

      {securityLocked && !ended && (
        <div className="mx-4 mt-2 rounded-lg bg-violet-500/10 border border-violet-500/20 px-3 py-2.5 flex-shrink-0">
          <p className="text-xs text-violet-300 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" /> Admin details are protected. Enter the chat password to see them.
          </p>
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); unlockChat() }}
          >
            <input
              type="password"
              value={unlockPw}
              onChange={e => setUnlockPw(e.target.value)}
              placeholder="Chat password"
              autoComplete="off"
              className="flex-1 min-w-0 bg-background border border-border rounded-full px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-violet-500/40"
            />
            <button
              type="submit"
              disabled={!unlockPw.trim() || unlocking}
              className="text-xs bg-violet-600 text-white px-3 py-1.5 rounded-full disabled:opacity-40 shrink-0"
            >
              {unlocking ? 'Checking…' : 'Unlock'}
            </button>
          </form>
          {unlockError && <p className="mt-1.5 text-[11px] text-red-400">{unlockError}</p>}
        </div>
      )}

      {hasArchive && (
        <button
          onClick={openArchive}
          className="mx-4 mt-2 text-center text-xs text-violet-500 hover:text-violet-400 bg-violet-500/10 rounded-lg py-2 flex-shrink-0"
        >
          🗂️ View earlier messages (archive)
        </button>
      )}

      <div className="flex-1 overflow-y-auto py-2 relative" style={{ background: activeWallpaper.background }}>
        {activeWallpaper.live && <LiveWallpaperOverlay type={activeWallpaper.live} />}
        <div className="relative z-10">
        {(() => {
          let lastDay: string | null = null
          return visibleMessages.map(m => {
            const day = chatDayKey(m.created_at)
            const showSeparator = day !== lastDay
            lastDay = day
            return (
              <div key={m.id} id={`lc-msg-${m.id}`}>
                {showSeparator && <DateSeparator label={formatDateSeparator(m.created_at)} />}
                <MessageBubble
                  message={m}
                  isMine={m.role === 'user'}
                  viewerRole="user"
                  replyToMessage={m.reply_to_id ? messages.find(x => x.id === m.reply_to_id) : null}
                  onReply={setReplyTarget}
                  onEdit={editMessage}
                  onUnsend={unsendMessage}
                  onRetry={retryMessage}
                  onJumpToReply={jumpToReply}
                  formatTime={fmtTime}
                  onViewMedia={openMedia}
                  onReact={handleReact}
                  onStar={handleStar}
                />
              </div>
            )
          })
        })()}
        {adminTyping && !ended && !securityLocked && <TypingIndicator name={securityLocked ? 'Admin' : agentName} />}
        <div ref={bottomRef} />
        </div>
      </div>

      <div className="p-3 border-t border-border flex-shrink-0 bg-background">
        {replyTarget && <ReplyPreview message={replyTarget} onCancel={() => setReplyTarget(null)} />}
        <div className="flex items-center gap-1 bg-muted/60 rounded-full pl-1 pr-1 py-1">
          {mediaError && <p className="text-[11px] text-red-400 px-3 pb-1">{mediaError}</p>}
                {compressPct !== null && <span className="text-[11px] text-violet-300 self-center mr-1">Compressing video… {compressPct}%</span>}
          {voicePhase === 'idle' && <MediaComposer disabled={!!ended || uploading} onSelect={handleMediaSelect} />}
          {voicePhase === 'idle' && <EmojiPickerButton buttonRef={emojiBtnRef} onClick={() => setEmojiOpen(v => !v)} />}
          {emojiOpen && (
            <EmojiPicker
              anchorRef={emojiBtnRef}
              onClose={() => setEmojiOpen(false)}
              onPickEmoji={(e) => setInput(v => v + e)}
              onPickGif={handlePickGif}
              onPickSticker={handlePickSticker}
            />
          )}
          {voicePhase === 'idle' && (
            <input
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
              disabled={!!ended}
              placeholder={ended ? 'This chat has ended' : uploading ? 'Sending media…' : 'Type a message…'}
              className="flex-1 min-w-0 bg-transparent rounded-full px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none disabled:opacity-50"
            />
          )}
          {input.trim() && voicePhase === 'idle' ? (
            <button onClick={sendMessage} disabled={!!ended} className="p-2.5 rounded-full bg-gradient-to-br from-blue-600 to-cyan-500 text-white disabled:opacity-40 shrink-0 shadow-sm">
              <Send className="w-4 h-4" />
            </button>
          ) : (
            <VoiceRecorder disabled={!!ended || uploading} onSend={handleVoiceSend} onPhaseChange={setVoicePhase} />
          )}
        </div>
      </div>

      <MediaViewerModal
        open={viewer.open} loading={viewer.loading} error={viewer.error}
        url={viewer.url} mediaType={viewer.mediaType} viewsRemaining={viewer.viewsRemaining}
        onClose={closeMediaViewer}
      />
      <EndChatConfirm open={confirmEnd} askReason onConfirm={doEndChat} onCancel={() => setConfirmEnd(false)} />
      <RetentionPicker open={retentionOpen} value={retention} seenDelay={retentionSeenDelay} onSelect={changeRetention} onClose={() => setRetentionOpen(false)} />
      <WallpaperPicker open={wallpaperPickerOpen} currentId={wallpaperId} onSelect={(w) => changeWallpaper(w.id)} onClose={() => setWallpaperPickerOpen(false)} />
      <ChatMediaGallery open={mediaGalleryOpen} chatId={chatId} onClose={() => setMediaGalleryOpen(false)} onOpenItem={openGalleryItem} />
      {/* When a parent supplies `externalCall`, it also owns rendering the
          global <CallModal/> so the call UI (and, importantly, the minimized
          floating bubble) keeps showing even after this panel unmounts. */}
      {!externalCall && (
        <CallModal
          state={call.state} callType={call.callType} peerName="Admin" error={call.error}
          localVideoEl={call.localVideoEl} remoteVideoEl={call.remoteVideoEl} remoteAudioEl={call.remoteAudioEl}
          localMuted={call.localMuted} localVideoOff={call.localVideoOff} speakerOn={call.speakerOn} duration={call.duration}
          onAccept={call.acceptCall} onReject={call.rejectCall} onEnd={call.endCall}
          onToggleMute={call.toggleMute} onToggleVideo={call.toggleVideo} onToggleSpeaker={call.toggleSpeaker}
          videoFilter={call.videoFilter} videoFilterOptions={call.videoFilterOptions} onSetVideoFilter={call.applyVideoFilter}
          proximitySupported={call.proximitySupported} screenDimmed={call.screenDimmed} onDismissScreenDim={call.dismissScreenDim}
          minimized={call.minimized} onToggleMinimize={call.toggleMinimize}
          pipSupported={call.pipSupported} pipActive={call.pipActive} onRequestPiP={call.requestPiP}
        />
      )}

      {archiveOpen && (
        <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-4" onClick={() => setArchiveOpen(false)}>
          <div className="w-full max-w-sm max-h-[80vh] bg-background rounded-2xl border border-border flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <p className="font-semibold text-sm text-foreground">Chat Archive</p>
              <button onClick={() => setArchiveOpen(false)} className="text-muted-foreground hover:text-foreground p-1"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto py-2">
              {!archiveStatus.granted ? (
                <div className="text-center text-sm text-muted-foreground px-6 py-8">
                  {archiveStatus.requested ? (
                    <>🔒 Your full chat history request has been sent to Admin.<br />You'll be able to view it here as soon as Admin approves.</>
                  ) : (
                    <>
                      🔒 Admin's last approval to view your full history has expired (approvals last 10 minutes).
                      <br /><br />
                      <button onClick={openArchive} className="text-violet-500 hover:text-violet-400 font-medium underline">
                        Request access again
                      </button>
                    </>
                  )}
                </div>
              ) : archiveLoading ? (
                <div className="text-center text-sm text-muted-foreground px-6 py-8">Loading full history…</div>
              ) : archiveMessages.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground px-6 py-8">No earlier messages in this chat yet.</div>
              ) : (
                <>
                  {archiveStatus.expiresAt && (
                    <ArchiveExpiryNotice expiresAt={archiveStatus.expiresAt} />
                  )}
                  {(() => {
                  let lastDay: string | null = null
                  return archiveMessages.map(m => {
                    const day = chatDayKey(m.created_at)
                    const showSeparator = day !== lastDay
                    lastDay = day
                    return (
                      <div key={m.id}>
                        {showSeparator && <DateSeparator label={formatDateSeparator(m.created_at)} />}
                        <MessageBubble
                          message={m}
                          isMine={m.role === 'user'}
                          viewerRole="user"
                          replyToMessage={m.reply_to_id ? archiveMessages.find(x => x.id === m.reply_to_id) : null}
                          onReply={() => {}}
                          onEdit={() => {}}
                          onUnsend={() => {}}
                          onJumpToReply={() => {}}
                          formatTime={fmtTime}
                          onViewMedia={openMedia}
                        />
                      </div>
                    )
                  })
                })()}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )

  // Full-screen (mobile always, desktop when `forceFullscreen`) needs to
  // escape the animated (transformed) widget wrapper to actually cover the
  // full viewport — see the `mounted` effect above.
  if (fullscreen) {
    return mounted ? createPortal(panel, document.body) : null
  }
  return panel
}
