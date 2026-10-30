/**
 * lib/live-chat-db.ts
 *
 * All Live Chat v2 persistence logic (Neon Postgres — same DB you already
 * use). Purely additive: existing `live_chats` / `live_chat_messages`
 * tables and rows are untouched; we only ADD columns (IF NOT EXISTS) and
 * ADD new tables. Nothing here can break the existing simple chat flow.
 */
import { neon } from '@neondatabase/serverless'

let _sql: ReturnType<typeof neon> | null = null
function getSql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set')
    }
    _sql = neon(process.env.DATABASE_URL)
  }
  return _sql
}
// Lazy proxy: behaves like the real neon client (tagged-template calls,
// sql(query, params) calls, and any helper methods) but only connects
// on first actual use, so importing this module at build time never
// requires DATABASE_URL to be set.
const sql: ReturnType<typeof neon> = new Proxy(function () {} as any, {
  apply(_target, thisArg, args) {
    return Reflect.apply(getSql() as any, thisArg, args)
  },
  get(_target, prop) {
    return (getSql() as any)[prop]
  },
})

const EDIT_WINDOW_MS = 60_000
const UNSEND_WINDOW_MS = 15_000
const AWAY_AFTER_MS = 20_000        // no heartbeat/activity for 20s -> away
const OFFLINE_AFTER_MS = 5 * 60_000 // away for 5 minutes -> offline
const CONTINUE_LOOKBACK = 3          // last 3 sessions
const ARCHIVE_GRANT_TTL_MS = 10 * 60_000 // admin's archive approval is only valid for 10 minutes
const RECENT_MESSAGE_LIMIT = 20       // latest N shown live; rest lives in the archive

let migrated = false

export async function ensureLiveChatSchema() {
  if (migrated) return
  migrated = true

  // ── Base tables (match app/api/live-chat/route.ts so this is safe even
  //    if that route hasn't run first) ──────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS live_chats (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT 'Visitor',
    user_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`
  await sql`CREATE TABLE IF NOT EXISTS live_chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`

  // ── New columns on live_chats ──────────────────────────────────────────
  const chatCols: [string, string][] = [
    ['device_id', "TEXT NOT NULL DEFAULT ''"],
    ['user_phone', "TEXT NOT NULL DEFAULT ''"],
    ['approved', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['ended_by_user', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['ended_by_admin', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    // ── End-chat reason (shown instantly to the other side) ───────────────
    ['end_reason', 'TEXT'],
    ['ended_at', 'BIGINT'],
    // ── Admin can hide everything before this moment from the user's view
    //    (without deleting anything — admin/archive can always see it all) ──
    ['history_hidden_from_user', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['history_hidden_at', 'BIGINT'],
    ['saved', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['saved_at', 'BIGINT'],
    ['saved_by', 'TEXT'],
    ['unread_since_cleanup', 'INTEGER NOT NULL DEFAULT 0'],
    // ── Archive access (older messages beyond the latest 20 shown live) ──
    // A visitor must request access and have an admin approve it before
    // they can see their full chat history; the admin can always see it.
    ['archive_requested_at', 'BIGINT'],
    ['archive_access_granted', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['archive_granted_at', 'BIGINT'],
    // ── AI hybrid chat: true while the AI is answering on Abhishek's
    //    behalf because he's offline; flips to FALSE (with a handoff
    //    message) the moment he comes online or replies himself. ─────────
    ['ai_active', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    // ── Chat wallpaper (background + auto-derived bubble colors) ─────────
    // Either side (user or admin) can change it; it's stored on the chat
    // row itself so both sides render the same wallpaper instantly via
    // realtime broadcast, and is also mirrored into
    // `live_chat_wallpaper_prefs` (keyed by phone number) so a returning
    // visitor gets the same wallpaper again automatically, on any device.
    ['wallpaper_id', "TEXT NOT NULL DEFAULT 'default'"],
    ['wallpaper_updated_at', 'BIGINT'],
    ['wallpaper_updated_by', 'TEXT'],
    // ── Browser fingerprint of the visitor who started this chat. Used to\n    //    recognise the same device after its cookies are cleared. ──────────
    ['device_fingerprint', "TEXT NOT NULL DEFAULT ''"],
    // ── Extra Security (per chat): the admin sets a password for this chat.\n    //    Until the visitor enters it, admin details (presence, availability,\n    //    typing) are hidden from them. Only a scrypt hash is stored. ───────
    ['security_enabled', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['security_password_hash', 'TEXT'],
    ['security_password_set_at', 'BIGINT'],
    // ── Reply timer: seconds the visitor has to reply after an admin message
    //    before their device is blocked. 0 = off. ────────────────────────────
    ['block_timer_seconds', 'INTEGER NOT NULL DEFAULT 0'],
    // Set when the admin sends a message that the visitor has not answered yet.
    ['awaiting_reply_since', 'BIGINT'],
    // ── Block state (the device itself is recorded in live_chat_device_blocks) ─
    ['blocked_at', 'BIGINT'],
    ['blocked_reason', 'TEXT'],
    // ── Auto-delete for this chat: seen | 24h | 7d | never. Either side can set it.
    ['retention', "TEXT NOT NULL DEFAULT 'never'"],
    ['retention_set_by', 'TEXT'],
    ['retention_set_at', 'BIGINT'],
    // ── "Delete after seen": seconds to wait after the other side has read a message.
    //    0 = delete right away. ─────────────────────────────────────────────
    ['retention_seen_delay', 'INTEGER NOT NULL DEFAULT 0'],
    // ── Set when the visitor closes a blocked chat by entering the password. ──
    ['blocked_dismissed_at', 'BIGINT'],
    // Who is handling the chat right now: name + role (admin | coadmin) + when they last replied.
    ['agent_name', 'TEXT'],
    ['agent_role', 'TEXT'],
    ['agent_at', 'BIGINT'],
  ]
  let migrationFailed = false
  for (const [col, def] of chatCols) {
    try { await sql(`ALTER TABLE live_chats ADD COLUMN IF NOT EXISTS ${col} ${def}`, []) }
    catch (err) {
      migrationFailed = true
      console.error(`[live-chat] could not add column live_chats.${col}:`, err)
    }
  }
  // If a column couldn't be added, let the next request try again.
  if (migrationFailed) migrated = false
  await sql`CREATE INDEX IF NOT EXISTS idx_live_chats_device ON live_chats (device_id, created_at DESC)`

  // ── Per-visitor wallpaper preference, keyed by mobile number ──────────
  // This is what makes the wallpaper "permanent" for a returning user:
  // whenever they start/resume a chat from a new browser/device, we look
  // this up by their phone number and pre-apply it to the (new) chat row.
  await sql`CREATE TABLE IF NOT EXISTS live_chat_wallpaper_prefs (
    phone TEXT PRIMARY KEY,
    wallpaper_id TEXT NOT NULL DEFAULT 'default',
    updated_at BIGINT NOT NULL
  )`

  // ── New columns on live_chat_messages ─────────────────────────────────
  const msgCols: [string, string][] = [
    ['client_id', 'TEXT'],
    ['reply_to_id', 'TEXT'],
    ['edited_at', 'BIGINT'],
    ['unsent_at', 'BIGINT'],
    ['status', "TEXT NOT NULL DEFAULT 'sent'"], // sent | delivered | read | failed
    ['delivered_at', 'BIGINT'],
    ['read_at', 'BIGINT'],
    // Name of whoever sent an admin-side message (Abhishek, or a co-admin).
    ['sender_name', 'TEXT'],
    // Link preview (JSON) fetched when a message containing a link is sent.
    ['link_preview', 'TEXT'],
    // ── View-once media (image/video, incl. live camera capture) ─────────
    ['media_url', 'TEXT'],
    ['media_type', 'TEXT'], // 'image' | 'video'
    ['media_view_limit', 'INTEGER NOT NULL DEFAULT 2'],
    ['media_view_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['media_locked', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    // ── "Keep in chat media" — sender opted to permanently save this
    //    photo/video instead of sending it view-once/view-twice. It never
    //    locks, is visible immediately to both sides like a normal photo,
    //    and shows up for both sides in the shared Chat Media gallery
    //    (alongside voice notes, which are always kept automatically). ───
    ['media_keep', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    // ── Voice notes (image/video reuse media_url; audio uses the same
    //    column + media_type='audio', but is NOT view-once) ───────────────
    ['duration_ms', 'INTEGER'],
    // ── Reactions (one emoji per side per message, WhatsApp/quick-react style)
    ['user_reaction', 'TEXT'],
    ['admin_reaction', 'TEXT'],
    // ── Starred messages (per side) ────────────────────────────────────────
    ['starred_by_user', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['starred_by_admin', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    // ── Forwarding ──────────────────────────────────────────────────────
    ['forwarded', 'BOOLEAN NOT NULL DEFAULT FALSE'],
  ]
  for (const [col, def] of msgCols) {
    try { await sql(`ALTER TABLE live_chat_messages ADD COLUMN IF NOT EXISTS ${col} ${def}`, []) } catch {}
  }
  try {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_live_chat_messages_client_id
      ON live_chat_messages (chat_id, client_id) WHERE client_id IS NOT NULL`
  } catch {}
  await sql`CREATE INDEX IF NOT EXISTS idx_live_chat_messages_chat ON live_chat_messages (chat_id, created_at ASC)`

  // ── Presence ────────────────────────────────────────────────────────
  await sql`CREATE TABLE IF NOT EXISTS live_chat_presence (
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    last_active BIGINT NOT NULL,
    became_away_at BIGINT,
    in_chat BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (chat_id, role)
  )`

  // ── Call log (history/missed calls; live signalling itself is realtime-only) ──
  await sql`CREATE TABLE IF NOT EXISTS live_chat_calls (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'audio',
    caller_role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ringing',
    started_at BIGINT NOT NULL,
    ended_at BIGINT,
    duration_ms BIGINT
  )`

  // ── Extra Security unlocks: which visitor devices entered the chat password.\n  //    Once unlocked, that device sees admin details for this chat. ──────────
  await sql`CREATE TABLE IF NOT EXISTS live_chat_unlocks (
    chat_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    unlocked_at BIGINT NOT NULL,
    PRIMARY KEY (chat_id, device_id)
  )`

  // ── Device blocks (created when a visitor misses the reply timer). A block
  //    matches by signed device cookie OR browser fingerprint, so clearing
  //    cookies doesn't get around it. Not tied to IP. ───────────────────────
  await sql`CREATE TABLE IF NOT EXISTS live_chat_device_blocks (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL DEFAULT '',
    chat_id TEXT,
    reason TEXT,
    blocked_at BIGINT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    unblocked_at BIGINT
  )`
  await sql`CREATE INDEX IF NOT EXISTS idx_device_blocks_device ON live_chat_device_blocks (device_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_device_blocks_fp ON live_chat_device_blocks (fingerprint)`

  // ── Admin (Abhishek) online/offline status — a single global row, since
  //    there's one admin. Drives the "leave a message" fallback + the AI
  //    hybrid chat auto-responder + human handoff. ───────────────────────
  await sql`CREATE TABLE IF NOT EXISTS live_chat_admin_status (
    id TEXT PRIMARY KEY DEFAULT 'global',
    online BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen BIGINT
  )`
  await sql`INSERT INTO live_chat_admin_status (id, online, last_seen) VALUES ('global', FALSE, NULL) ON CONFLICT (id) DO NOTHING`
}

// ─────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────

export async function insertMessage(opts: {
  chatId: string
  role: 'user' | 'admin' | 'ai' | 'system'
  content: string
  clientId?: string
  replyToId?: string
  mediaUrl?: string
  mediaType?: 'image' | 'video' | 'audio' | 'gif' | 'sticker'
  mediaViewLimit?: number
  /** Sender chose "Keep in chat media" instead of view-once/view-twice —
   *  only meaningful for image/video; ignored for other media types since
   *  those are already always-visible & unlimited. */
  mediaKeep?: boolean
  durationMs?: number
  /** When the sender picked the message (used for media, which can take a while to upload). */
  createdAt?: number
}) {
  await ensureLiveChatSchema()
  const { chatId, role, content, clientId, replyToId, mediaUrl, mediaType, mediaViewLimit, mediaKeep, durationMs } = opts
  const now = opts.createdAt ?? Date.now()

  // Only image/video are "view-once" (locked after N opens); voice notes,
  // GIFs and stickers are always freely viewable/playable like a normal
  // message, so they get an effectively-unlimited view count instead.
  const isViewOnceType = mediaType === 'image' || mediaType === 'video'
  const keep = !!mediaKeep && isViewOnceType

  // Idempotency: if this client_id was already inserted (retry/duplicate
  // network send), return the existing row instead of creating a duplicate.
  if (clientId) {
    const existing = await sql`SELECT * FROM live_chat_messages WHERE chat_id = ${chatId} AND client_id = ${clientId} LIMIT 1`
    if (existing.length) return { message: existing[0], duplicate: true }
  }

  const id = `msg_${now}_${Math.random().toString(36).slice(2, 9)}`
  const rows = await sql`
    INSERT INTO live_chat_messages (id, chat_id, role, content, created_at, client_id, reply_to_id, status, media_url, media_type, media_view_limit, media_keep, duration_ms)
    VALUES (${id}, ${chatId}, ${role}, ${content.slice(0, 2000)}, ${now}, ${clientId || null}, ${replyToId || null}, 'sent',
            ${mediaUrl || null}, ${mediaType || null},
            ${mediaUrl ? (keep ? 999999 : isViewOnceType ? (mediaViewLimit || 2) : 999999) : 2},
            ${keep}, ${durationMs || null})
    ON CONFLICT (chat_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
    RETURNING *`

  const message = rows[0] || (clientId
    ? (await sql`SELECT * FROM live_chat_messages WHERE chat_id = ${chatId} AND client_id = ${clientId} LIMIT 1`)[0]
    : null)

  await sql`UPDATE live_chats SET updated_at = ${now} WHERE id = ${chatId}`

  // NOTE: by default messages are kept permanently. A chat can opt into
  // auto-delete (seen / 24h / 7d — see purgeChatMessages below); the default
  // is "never", so nothing is removed unless someone picks that option. The
  // live view only *shows* the latest RECENT_MESSAGE_LIMIT messages (see
  // getRecentMessages); everything older lives in the archive.

  return { message, duplicate: false }
}

export async function editMessage(chatId: string, messageId: string, role: 'user' | 'admin', newContent: string) {
  await ensureLiveChatSchema()
  const rows = await sql`SELECT * FROM live_chat_messages WHERE id = ${messageId} AND chat_id = ${chatId} LIMIT 1`
  const msg = rows[0]
  if (!msg) return { error: 'Message not found', status: 404 }
  if (msg.role !== role) return { error: 'You can only edit your own messages', status: 403 }
  if (msg.unsent_at) return { error: 'Message was unsent', status: 400 }
  const age = Date.now() - Number(msg.created_at)
  if (age > EDIT_WINDOW_MS) return { error: 'Edit window (60s) has expired', status: 403 }

  const now = Date.now()
  const updated = await sql`UPDATE live_chat_messages SET content = ${newContent.slice(0, 2000)}, edited_at = ${now}
    WHERE id = ${messageId} RETURNING *`
  return { message: updated[0] }
}

export async function unsendMessage(chatId: string, messageId: string, role: 'user' | 'admin') {
  await ensureLiveChatSchema()
  const rows = await sql`SELECT * FROM live_chat_messages WHERE id = ${messageId} AND chat_id = ${chatId} LIMIT 1`
  const msg = rows[0]
  if (!msg) return { error: 'Message not found', status: 404 }
  if (msg.role !== role) return { error: 'You can only unsend your own messages', status: 403 }
  const age = Date.now() - Number(msg.created_at)
  if (age > UNSEND_WINDOW_MS) return { error: 'Unsend window (15s) has expired', status: 403 }

  const now = Date.now()
  const updated = await sql`UPDATE live_chat_messages SET content = '', unsent_at = ${now} WHERE id = ${messageId} RETURNING *`
  return { message: updated[0] }
}

export async function markDelivered(chatId: string, viewerRole: 'user' | 'admin') {
  await ensureLiveChatSchema()
  const now = Date.now()
  // Messages sent BY THE OTHER SIDE become delivered once this viewer's
  // client has polled/received them.
  const otherRole = viewerRole === 'user' ? 'admin' : 'user'
  const rows = await sql`UPDATE live_chat_messages SET status = 'delivered', delivered_at = ${now}
    WHERE chat_id = ${chatId} AND role = ${otherRole} AND status = 'sent' RETURNING id`
  return rows.map((r: any) => r.id)
}

export async function markRead(chatId: string, viewerRole: 'user' | 'admin') {
  await ensureLiveChatSchema()
  const now = Date.now()
  const otherRole = viewerRole === 'user' ? 'admin' : 'user'
  const rows = await sql`UPDATE live_chat_messages SET status = 'read', read_at = ${now},
      delivered_at = COALESCE(delivered_at, ${now})
    WHERE chat_id = ${chatId} AND role = ${otherRole} AND status != 'read' AND unsent_at IS NULL RETURNING id`
  return rows.map((r: any) => r.id)
}

// ─────────────────────────────────────────────────────────────────────────
// Reactions, starring, forwarding
// ─────────────────────────────────────────────────────────────────────────

const ALLOWED_REACTIONS = new Set(['❤️', '😂', '👍', '🔥', '😮', '😢'])

/** Toggle (set/clear/replace) this viewer's reaction on a message. */
export async function toggleReaction(chatId: string, messageId: string, viewerRole: 'user' | 'admin', emoji: string) {
  await ensureLiveChatSchema()
  if (!ALLOWED_REACTIONS.has(emoji)) return { error: 'Unsupported reaction', status: 400 }
  const col = viewerRole === 'user' ? 'user_reaction' : 'admin_reaction'
  const rows = await sql(`SELECT ${col} AS current FROM live_chat_messages WHERE id = $1 AND chat_id = $2`, [messageId, chatId])
  if (!rows.length) return { error: 'Message not found', status: 404 }
  const next = rows[0].current === emoji ? null : emoji
  const updated = await sql(`UPDATE live_chat_messages SET ${col} = $1 WHERE id = $2 AND chat_id = $3 RETURNING *`, [next, messageId, chatId])
  return { message: updated[0] }
}

export async function toggleStar(chatId: string, messageId: string, viewerRole: 'user' | 'admin') {
  await ensureLiveChatSchema()
  const col = viewerRole === 'user' ? 'starred_by_user' : 'starred_by_admin'
  const rows = await sql(`SELECT ${col} AS current FROM live_chat_messages WHERE id = $1 AND chat_id = $2`, [messageId, chatId])
  if (!rows.length) return { error: 'Message not found', status: 404 }
  const next = !rows[0].current
  const updated = await sql(`UPDATE live_chat_messages SET ${col} = $1 WHERE id = $2 AND chat_id = $3 RETURNING *`, [next, messageId, chatId])
  return { message: updated[0] }
}

/** Admin-only: copy a message's content/media into a different chat. */
export async function forwardMessage(fromChatId: string, messageId: string, toChatId: string, role: 'user' | 'admin') {
  await ensureLiveChatSchema()
  const src = (await sql`SELECT * FROM live_chat_messages WHERE id = ${messageId} AND chat_id = ${fromChatId} LIMIT 1`)[0]
  if (!src) return { error: 'Message not found', status: 404 }
  if (src.unsent_at) return { error: 'Cannot forward an unsent message', status: 400 }
  const { message } = await insertMessage({
    chatId: toChatId, role, content: src.content || '',
    mediaUrl: src.media_url || undefined, mediaType: src.media_type || undefined,
    mediaKeep: !!src.media_keep,
    durationMs: src.duration_ms ? Number(src.duration_ms) : undefined,
  })
  if (message) await sql`UPDATE live_chat_messages SET forwarded = TRUE WHERE id = ${message.id}`
  return { message: { ...message, forwarded: true } }
}

// ─────────────────────────────────────────────────────────────────────────
// Admin online/offline status — drives "leave a message" + AI hybrid chat
// ─────────────────────────────────────────────────────────────────────────

const ADMIN_ONLINE_TTL_MS = 30_000 // no heartbeat for 30s -> considered offline

export async function adminHeartbeat() {
  await ensureLiveChatSchema()
  const now = Date.now()
  const before = (await sql`SELECT online, last_seen FROM live_chat_admin_status WHERE id = 'global'`)[0]
  const wasOnline = !!before?.online && before?.last_seen && (now - Number(before.last_seen)) < ADMIN_ONLINE_TTL_MS
  await sql`UPDATE live_chat_admin_status SET online = TRUE, last_seen = ${now} WHERE id = 'global'`
  return { justCameOnline: !wasOnline }
}

export async function getAdminOnlineStatus() {
  await ensureLiveChatSchema()
  const row = (await sql`SELECT online, last_seen FROM live_chat_admin_status WHERE id = 'global'`)[0]
  if (!row?.last_seen) return { online: false }
  const online = !!row.online && (Date.now() - Number(row.last_seen)) < ADMIN_ONLINE_TTL_MS
  return { online }
}

/** Every chat currently being auto-answered by the AI (admin offline). */
export async function getAiActiveChats() {
  await ensureLiveChatSchema()
  return sql`SELECT id FROM live_chats WHERE ai_active = TRUE AND status != 'closed'`
}

export async function setAiActive(chatId: string, active: boolean) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET ai_active = ${active} WHERE id = ${chatId}`
}

// ─────────────────────────────────────────────────────────────────────────
// View-once media (image/video, incl. live camera capture)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Strips the real media URL out of a message before it's sent over the
 * wire in a list/poll response, so the file stays hidden until the
 * recipient explicitly opens it via `viewMedia`. Sender always gets a
 * `canReveal: true` flag since they can always re-open their own send.
 */
export function maskMediaForTransport<T extends Record<string, any>>(msg: T, viewerRole: 'user' | 'admin'): T {
  if (!msg.media_url) return msg
  // Only image/video are view-once; voice notes, GIFs and stickers always
  // travel with their real URL so they play immediately for both sides.
  if (msg.media_type !== 'image' && msg.media_type !== 'video') return msg
  // "Keep in chat media" photos/videos are never masked — they're meant to
  // be visible immediately, like a normal message, and to live on in the
  // shared Chat Media gallery.
  if (msg.media_keep) return { ...msg, is_sender: msg.role === viewerRole }
  const isSender = msg.role === viewerRole
  const { media_url, ...rest } = msg
  return {
    ...rest,
    has_media: true,
    media_url: null,
    is_sender: isSender,
  } as unknown as T
}

/**
 * Called when a user taps/clicks a locked media bubble to view it.
 * - The sender can always re-open their own media (no view is consumed).
 * - The receiver gets a maximum of `media_view_limit` opens (default 2).
 *   Once exhausted, the media is permanently locked/hidden.
 */
export async function viewMedia(chatId: string, messageId: string, viewerRole: 'user' | 'admin') {
  await ensureLiveChatSchema()
  const rows = await sql`SELECT * FROM live_chat_messages WHERE id = ${messageId} AND chat_id = ${chatId} LIMIT 1`
  const msg = rows[0]
  if (!msg) return { error: 'Message not found', status: 404 }
  if (!msg.media_url) return { error: 'This message has no media', status: 400 }
  if (msg.unsent_at) return { error: 'Message was unsent', status: 400 }

  const isSender = msg.role === viewerRole

  if (msg.media_keep) {
    // Kept media never locks and never consumes a view — either side can
    // reopen it any number of times, exactly like a normal photo/video.
    return {
      url: msg.media_url,
      mediaType: msg.media_type,
      viewsRemaining: null,
      locked: false,
      publicMessage: { ...msg, is_sender: isSender },
    }
  }

  if (isSender) {
    // Sender can always review their own sent media, no view consumed.
    return {
      url: msg.media_url,
      mediaType: msg.media_type,
      viewsRemaining: Math.max(0, Number(msg.media_view_limit) - Number(msg.media_view_count)),
      locked: !!msg.media_locked,
      publicMessage: msg,
    }
  }

  if (msg.media_locked) {
    return { error: 'This media is no longer available. It has already been viewed the maximum number of times.', status: 410 }
  }

  const newCount = Number(msg.media_view_count) + 1
  const limit = Number(msg.media_view_limit) || 2
  const willLock = newCount >= limit

  const updated = await sql`
    UPDATE live_chat_messages
    SET media_view_count = ${newCount}, media_locked = ${willLock}
    WHERE id = ${messageId} RETURNING *`

  return {
    url: msg.media_url,
    mediaType: msg.media_type,
    viewsRemaining: Math.max(0, limit - newCount),
    locked: willLock,
    publicMessage: maskMediaForTransport(updated[0], viewerRole),
  }
}

/**
 * All media either side chose to permanently keep in this chat, plus every
 * voice note (which is always kept/unlimited by nature) — this is exactly
 * what backs the "Chat Media" gallery both the user and admin can open,
 * showing every photo, video and audio message ever shared in the chat.
 * Unsent messages are excluded. Newest first.
 */
export async function getChatMedia(chatId: string) {
  await ensureLiveChatSchema()
  const rows = await sql`
    SELECT id, chat_id, role, media_url, media_type, duration_ms, created_at
    FROM live_chat_messages
    WHERE chat_id = ${chatId} AND unsent_at IS NULL AND media_url IS NOT NULL
      AND (media_keep = TRUE OR media_type = 'audio')
    ORDER BY created_at DESC`
  return rows
}

// ─────────────────────────────────────────────────────────────────────────
// Presence
// ─────────────────────────────────────────────────────────────────────────

export async function heartbeat(chatId: string, role: 'user' | 'admin', activeTab: boolean) {
  await ensureLiveChatSchema()
  const now = Date.now()
  const existing = (await sql`SELECT * FROM live_chat_presence WHERE chat_id = ${chatId} AND role = ${role}`)[0]

  if (activeTab) {
    // Actively in chat -> always Online, clear away marker.
    await sql`INSERT INTO live_chat_presence (chat_id, role, last_active, became_away_at, in_chat)
      VALUES (${chatId}, ${role}, ${now}, NULL, TRUE)
      ON CONFLICT (chat_id, role) DO UPDATE SET last_active = ${now}, became_away_at = NULL, in_chat = TRUE`
  } else {
    const becameAway = existing?.became_away_at || now
    await sql`INSERT INTO live_chat_presence (chat_id, role, last_active, became_away_at, in_chat)
      VALUES (${chatId}, ${role}, ${now}, ${becameAway}, FALSE)
      ON CONFLICT (chat_id, role) DO UPDATE SET last_active = ${now},
        became_away_at = COALESCE(live_chat_presence.became_away_at, ${now}), in_chat = FALSE`
  }
  return getPresence(chatId)
}

export async function getPresence(chatId: string) {
  await ensureLiveChatSchema()
  const rows = await sql`SELECT * FROM live_chat_presence WHERE chat_id = ${chatId}`
  const now = Date.now()
  const result: Record<string, { status: 'online' | 'away' | 'offline'; awaySeconds: number; lastActiveAt: number | null }> = {}
  for (const role of ['user', 'admin']) {
    const r = rows.find((x: any) => x.role === role)
    if (!r) { result[role] = { status: 'offline', awaySeconds: 0, lastActiveAt: null }; continue }
    const lastActiveAt = Number(r.last_active)
    const sinceActive = now - lastActiveAt
    if (r.in_chat && sinceActive < AWAY_AFTER_MS) {
      result[role] = { status: 'online', awaySeconds: 0, lastActiveAt }
    } else {
      const awaySince = r.became_away_at ? Number(r.became_away_at) : lastActiveAt
      const awayMs = now - awaySince
      result[role] = awayMs >= OFFLINE_AFTER_MS
        ? { status: 'offline', awaySeconds: Math.floor(awayMs / 1000), lastActiveAt }
        : { status: 'away', awaySeconds: Math.floor(awayMs / 1000), lastActiveAt }
    }
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────
// Save chat / Continue chat / End chat
// ─────────────────────────────────────────────────────────────────────────

export async function saveChat(chatId: string, savedBy: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET saved = TRUE, saved_at = ${Date.now()}, saved_by = ${savedBy} WHERE id = ${chatId}`
}

export async function unsaveChat(chatId: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET saved = FALSE, saved_at = NULL, saved_by = NULL WHERE id = ${chatId}`
}

export async function getSavedChats() {
  await ensureLiveChatSchema()
  const chats = await sql`SELECT * FROM live_chats WHERE saved = TRUE ORDER BY saved_at DESC`
  const withMessages = await Promise.all(chats.map(async (c: any) => {
    const messages = await sql`SELECT * FROM live_chat_messages WHERE chat_id = ${c.id} ORDER BY created_at ASC`
    return { ...c, messages }
  }))
  return withMessages
}

export async function endChat(chatId: string, endedBy: 'user' | 'admin', reason?: string) {
  await ensureLiveChatSchema()
  const col = endedBy === 'user' ? 'ended_by_user' : 'ended_by_admin'
  const now = Date.now()
  const cleanReason = (reason || '').trim().slice(0, 300) || null
  await sql(
    `UPDATE live_chats SET status = 'closed', ${col} = TRUE, end_reason = $2, ended_at = $3, updated_at = $3 WHERE id = $1`,
    [chatId, cleanReason, now]
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Hide / show previous chat history from the user's side (admin-controlled).
// Nothing is ever deleted — the admin (and the archive, once re-shown) can
// always see everything. This only affects what the *user's* client fetches.
// ─────────────────────────────────────────────────────────────────────────

export async function setHistoryHiddenFromUser(chatId: string, hidden: boolean) {
  await ensureLiveChatSchema()
  const now = Date.now()
  if (hidden) {
    await sql`UPDATE live_chats SET history_hidden_from_user = TRUE, history_hidden_at = ${now} WHERE id = ${chatId}`
  } else {
    await sql`UPDATE live_chats SET history_hidden_from_user = FALSE, history_hidden_at = NULL WHERE id = ${chatId}`
  }
  return { hidden, hiddenAt: hidden ? now : null }
}

export async function getHistoryHiddenStatus(chatId: string) {
  await ensureLiveChatSchema()
  const rows = await sql`SELECT history_hidden_from_user, history_hidden_at FROM live_chats WHERE id = ${chatId}`
  const row = rows[0]
  return { hidden: !!row?.history_hidden_from_user, hiddenAt: row?.history_hidden_at ? Number(row.history_hidden_at) : null }
}

/**
 * Returns eligibility info for a returning visitor: whether they qualify
 * for "Continue Chat" (chatted with Admin, i.e. got an approved/active
 * session, within their last 3 chat sessions) and the chat they should
 * continue, if any.
 *
 * Looks up by device first (works even if they didn't share a phone
 * number), and — if a phone number was given — also by that phone number,
 * so "the same visitor" is recognized across devices/browsers too. The
 * phone match takes priority when both would apply, since a phone number
 * is a stronger identity signal than a device cookie.
 *
 * A phone number is treated as a permanent identity: it always continues
 * the single most recent conversation tied to that number — even if that
 * conversation was previously ended — rather than starting a new, separate
 * chat thread each time. `recentChat.status === 'closed'` tells the caller
 * to reopen it. Device-only matches keep the old, session-scoped behavior
 * (only auto-resume if still open) since there's no strong identity there.
 */
export async function getReturningUserInfo(deviceId: string, phone?: string) {
  await ensureLiveChatSchema()
  const cleanPhone = (phone || '').trim()

  if (cleanPhone) {
    const byPhone = await sql`SELECT * FROM live_chats WHERE user_phone = ${cleanPhone}
      ORDER BY created_at DESC LIMIT ${CONTINUE_LOOKBACK}`
    if (byPhone.length) {
      const eligible = byPhone.some((c: any) => c.approved === true)
      // Always continue the same phone number's most recent conversation,
      // reopening it if it had been ended — one continuous thread per number.
      return { eligible, recentChat: byPhone[0], history: byPhone, matchedBy: 'phone' as const }
    }
    // Fall back to matching the last 10 digits, so "9876543210" and
    // "+91 98765 43210" (same number, different formatting/country code)
    // are still recognized as the same visitor.
    const last10 = cleanPhone.replace(/\D/g, '').slice(-10)
    if (last10.length === 10) {
      const byLast10 = await sql`SELECT * FROM live_chats
        WHERE user_phone != '' AND RIGHT(REGEXP_REPLACE(user_phone, '\\D', '', 'g'), 10) = ${last10}
        ORDER BY created_at DESC LIMIT ${CONTINUE_LOOKBACK}`
      if (byLast10.length) {
        const eligible = byLast10.some((c: any) => c.approved === true)
        return { eligible, recentChat: byLast10[0], history: byLast10, matchedBy: 'phone' as const }
      }
    }
  }

  if (!deviceId) return { eligible: false, recentChat: null, history: [], matchedBy: null }
  const history = await sql`SELECT * FROM live_chats WHERE device_id = ${deviceId}
    ORDER BY created_at DESC LIMIT ${CONTINUE_LOOKBACK}`
  const eligible = history.some((c: any) => c.approved === true)
  const openChat = history.find((c: any) => c.status !== 'closed')
  return { eligible, recentChat: openChat || null, history, matchedBy: history.length ? ('device' as const) : null }
}

export async function approveChat(chatId: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET approved = TRUE, status = 'active', updated_at = ${Date.now()} WHERE id = ${chatId}`
}

/**
 * Reopens a previously-ended chat so the same phone number continues in
 * the exact same thread instead of a new one being created. Clears the
 * "ended" state (status/reason/flags) but leaves every message untouched —
 * the full history stays exactly where it was.
 */
export async function reopenChat(chatId: string, approved: boolean) {
  await ensureLiveChatSchema()
  const now = Date.now()
  await sql`UPDATE live_chats SET
    status = ${approved ? 'active' : 'pending'},
    ended_by_user = FALSE, ended_by_admin = FALSE, end_reason = NULL, ended_at = NULL,
    updated_at = ${now}
    WHERE id = ${chatId}`
}

// ─────────────────────────────────────────────────────────────────────────
// Calls (history/log — live signalling happens over Supabase Realtime)
// ─────────────────────────────────────────────────────────────────────────

export async function logCallStart(chatId: string, type: 'audio' | 'video', callerRole: 'user' | 'admin') {
  await ensureLiveChatSchema()
  const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  await sql`INSERT INTO live_chat_calls (id, chat_id, type, caller_role, status, started_at)
    VALUES (${id}, ${chatId}, ${type}, ${callerRole}, 'ringing', ${Date.now()})`
  return id
}

export async function logCallEnd(callId: string, status: 'completed' | 'missed' | 'rejected' | 'failed') {
  await ensureLiveChatSchema()
  const now = Date.now()
  const rows = await sql`SELECT started_at FROM live_chat_calls WHERE id = ${callId}`
  const startedAt = rows[0]?.started_at ? Number(rows[0].started_at) : now
  await sql`UPDATE live_chat_calls SET status = ${status}, ended_at = ${now}, duration_ms = ${now - startedAt} WHERE id = ${callId}`
}

export { EDIT_WINDOW_MS, UNSEND_WINDOW_MS }

// ─────────────────────────────────────────────────────────────────────────
// Archive (all messages are saved forever; the live view only shows the
// latest RECENT_MESSAGE_LIMIT — older messages are reachable through this
// request/approve flow for a visitor, and are always open to the admin).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Latest N messages for the live view, oldest-first, plus whether there's
 * more in the archive. If `afterTs` is given (used when the admin has hidden
 * history from the user's side), only messages created after that moment
 * are considered at all — older ones stay fully intact in the DB/archive,
 * they're just not surfaced to this viewer.
 */
export async function getRecentMessages(chatId: string, limit: number = RECENT_MESSAGE_LIMIT, afterTs?: number | null) {
  await ensureLiveChatSchema()
  if (afterTs) {
    const totalRows = await sql`SELECT COUNT(*)::int AS count FROM live_chat_messages WHERE chat_id = ${chatId} AND created_at > ${afterTs}`
    const total = totalRows[0]?.count || 0
    const recent = await sql`SELECT * FROM live_chat_messages WHERE chat_id = ${chatId} AND created_at > ${afterTs}
      ORDER BY created_at DESC LIMIT ${limit}`
    return { messages: recent.reverse(), total, hasArchive: false }
  }
  const totalRows = await sql`SELECT COUNT(*)::int AS count FROM live_chat_messages WHERE chat_id = ${chatId}`
  const total = totalRows[0]?.count || 0
  const recent = await sql`SELECT * FROM live_chat_messages WHERE chat_id = ${chatId}
    ORDER BY created_at DESC LIMIT ${limit}`
  return { messages: recent.reverse(), total, hasArchive: total > recent.length }
}

/** Every message ever sent in this chat, oldest-first — the full archive. */
export async function getArchiveMessages(chatId: string) {
  await ensureLiveChatSchema()
  const messages = await sql`SELECT * FROM live_chat_messages WHERE chat_id = ${chatId} ORDER BY created_at ASC`
  return { messages }
}

/** A visitor asks to see their full history; flips to pending until an admin approves. */
export async function requestArchiveAccess(chatId: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET archive_requested_at = ${Date.now()}, archive_access_granted = FALSE WHERE id = ${chatId}`
}

/** Admin approves a pending (or fresh) archive-access request for this chat. */
export async function grantArchiveAccess(chatId: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET archive_access_granted = TRUE, archive_granted_at = ${Date.now()}, archive_requested_at = NULL WHERE id = ${chatId}`
}

/** Admin denies a pending archive-access request for this chat. */
export async function denyArchiveAccess(chatId: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET archive_access_granted = FALSE, archive_requested_at = NULL WHERE id = ${chatId}`
}

export async function getArchiveStatus(chatId: string) {
  await ensureLiveChatSchema()
  const rows = await sql`SELECT archive_requested_at, archive_access_granted, archive_granted_at FROM live_chats WHERE id = ${chatId}`
  const row = rows[0]
  const grantedAt = row?.archive_granted_at ? Number(row.archive_granted_at) : null
  // A grant only lasts 10 minutes — after that the visitor needs fresh
  // admin approval again, even though nothing was actually revoked in the
  // background (we just stop honoring the old grant once it's stale).
  const stillValid = !!row?.archive_access_granted && grantedAt !== null && (Date.now() - grantedAt) < ARCHIVE_GRANT_TTL_MS
  if (row?.archive_access_granted && !stillValid) {
    // Lazily clear the stale grant so the admin's UI reflects reality too.
    await sql`UPDATE live_chats SET archive_access_granted = FALSE WHERE id = ${chatId}`
  }
  return {
    requested: !!row?.archive_requested_at,
    granted: stillValid,
    requestedAt: row?.archive_requested_at ? Number(row.archive_requested_at) : null,
    grantedAt,
    expiresAt: stillValid ? grantedAt! + ARCHIVE_GRANT_TTL_MS : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Chat wallpaper — either side (user or admin) can change it; it's shared
// (stored once, on the chat row) so both sides see the same background +
// auto-matching bubble colors. Also mirrored into
// live_chat_wallpaper_prefs (keyed by phone) so a returning visitor gets
// their wallpaper back automatically on a brand-new chat/device.
// ─────────────────────────────────────────────────────────────────────────

export async function getChatWallpaper(chatId: string) {
  await ensureLiveChatSchema()
  const [row] = await sql`SELECT wallpaper_id, wallpaper_updated_at, wallpaper_updated_by FROM live_chats WHERE id = ${chatId}`
  return {
    wallpaperId: row?.wallpaper_id || 'default',
    updatedAt: row?.wallpaper_updated_at ? Number(row.wallpaper_updated_at) : null,
    updatedBy: row?.wallpaper_updated_by || null,
  }
}

/** Looks up the visitor's saved wallpaper preference by phone number.
 *  Used to pre-apply the right wallpaper the moment a returning user's
 *  chat is created/resumed — before they've touched the picker at all. */
export async function getWallpaperPrefByPhone(phone: string) {
  if (!phone) return null
  await ensureLiveChatSchema()
  const [row] = await sql`SELECT wallpaper_id FROM live_chat_wallpaper_prefs WHERE phone = ${phone}`
  return row?.wallpaper_id || null
}

/** Sets the wallpaper for one chat (both sides will see it — broadcast the
 *  `wallpaper_changed` realtime event after calling this), and — when a
 *  phone number is known for that visitor — permanently remembers the
 *  choice so it's restored automatically for that same visitor next time,
 *  on any device. The user (or admin) can always change it again later;
 *  "permanent" just means it survives across sessions until changed. */
export async function setChatWallpaper(chatId: string, wallpaperId: string, changedBy: 'user' | 'admin', phone?: string | null) {
  await ensureLiveChatSchema()
  const now = Date.now()
  await sql`UPDATE live_chats SET wallpaper_id = ${wallpaperId}, wallpaper_updated_at = ${now}, wallpaper_updated_by = ${changedBy}, updated_at = ${now} WHERE id = ${chatId}`
  const cleanPhone = (phone || '').trim()
  if (cleanPhone) {
    await sql`
      INSERT INTO live_chat_wallpaper_prefs (phone, wallpaper_id, updated_at)
      VALUES (${cleanPhone}, ${wallpaperId}, ${now})
      ON CONFLICT (phone) DO UPDATE SET wallpaper_id = EXCLUDED.wallpaper_id, updated_at = EXCLUDED.updated_at
    `
  }
  return { wallpaperId, updatedAt: now, updatedBy: changedBy }
}

/** Applies a returning visitor's saved wallpaper preference to a
 *  freshly-created or reopened chat row, if one exists for their phone
 *  number and the chat doesn't already have a non-default wallpaper. */
export async function applyReturningWallpaper(chatId: string, phone: string) {
  const saved = await getWallpaperPrefByPhone(phone)
  if (!saved || saved === 'default') return null
  await sql`UPDATE live_chats SET wallpaper_id = ${saved} WHERE id = ${chatId} AND wallpaper_id = 'default'`
  return saved
}

// ─────────────────────────────────────────────────────────────────────────
// Admin: permanently delete a chat (and everything attached to it). This
// is irreversible — unlike "End Chat" (which just closes it) or "Hide
// History" (which only hides it from the user), this removes every row
// from the database. Only ever called after the admin confirms via the
// "Are you sure?" dialog in the UI.
// ─────────────────────────────────────────────────────────────────────────

export async function deleteChatPermanently(chatId: string) {
  await ensureLiveChatSchema()
  await sql`DELETE FROM live_chat_messages WHERE chat_id = ${chatId}`
  await sql`DELETE FROM live_chat_presence WHERE chat_id = ${chatId}`
  await sql`DELETE FROM live_chat_calls WHERE chat_id = ${chatId}`
  await sql`DELETE FROM live_chat_unlocks WHERE chat_id = ${chatId}`
  await sql`DELETE FROM live_chats WHERE id = ${chatId}`
  // NOTE: device blocks are intentionally kept. Deleting a chat must not
  // lift a block that was earned by missing a reply.
  return { deleted: true }
}

// ─────────────────────────────────────────────────────────────────────────
// Extra Security (per chat). When it is on, admin details are hidden from
// the visitor until they enter this chat's password. The admin always sees
// everything. The password itself is hashed in lib/chat-security.ts.
// ─────────────────────────────────────────────────────────────────────────

const BLOCK_REASON_NO_REPLY = 'Chat closed: no reply within the time limit.'
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/** Turns Extra Security on with a new password hash, or off (clears the
 *  hash, every unlock, and the reply timer). Turning it on always clears
 *  old unlocks, so anyone who had the previous password must re-enter it. */
export async function setExtraSecurity(chatId: string, enabled: boolean, passwordHash?: string | null) {
  await ensureLiveChatSchema()
  const now = Date.now()
  if (enabled) {
    await sql`UPDATE live_chats SET security_enabled = TRUE, security_password_hash = ${passwordHash || null},
      security_password_set_at = ${now}, updated_at = ${now} WHERE id = ${chatId}`
  } else {
    await sql`UPDATE live_chats SET security_enabled = FALSE, security_password_hash = NULL,
      security_password_set_at = NULL, block_timer_seconds = 0, awaiting_reply_since = NULL,
      updated_at = ${now} WHERE id = ${chatId}`
  }
  await sql`DELETE FROM live_chat_unlocks WHERE chat_id = ${chatId}`
}

/** Returns the stored password hash for a chat (server-side use only). */
export async function getChatPasswordHash(chatId: string): Promise<string | null> {
  await ensureLiveChatSchema()
  const row = (await sql`SELECT security_password_hash FROM live_chats WHERE id = ${chatId}`)[0]
  return row?.security_password_hash || null
}

/** Whether this chat has Extra Security turned on. */
export async function isChatSecured(chatId: string): Promise<boolean> {
  await ensureLiveChatSchema()
  const row = (await sql`SELECT security_enabled FROM live_chats WHERE id = ${chatId}`)[0]
  return !!row?.security_enabled
}

/** True when the given device is a visitor on a secured chat that it has NOT
 *  unlocked yet. The caller decides what to do with that (typically: hide
 *  admin presence/typing/availability for this response). */
export async function isChatLockedForDevice(chatId: string, deviceId: string): Promise<boolean> {
  await ensureLiveChatSchema()
  const row = (await sql`SELECT security_enabled FROM live_chats WHERE id = ${chatId}`)[0]
  if (!row?.security_enabled) return false
  const unlocked = await sql`SELECT 1 FROM live_chat_unlocks WHERE chat_id = ${chatId} AND device_id = ${deviceId}`
  return unlocked.length === 0
}

export async function unlockChatForDevice(chatId: string, deviceId: string) {
  await ensureLiveChatSchema()
  await sql`INSERT INTO live_chat_unlocks (chat_id, device_id, unlocked_at) VALUES (${chatId}, ${deviceId}, ${Date.now()})
    ON CONFLICT (chat_id, device_id) DO NOTHING`
}

/** Sets the reply timer in seconds (0 = off). Turning it off also stops any
 *  countdown that is already running. */
export async function setBlockTimer(chatId: string, seconds: number) {
  await ensureLiveChatSchema()
  if (seconds === 0) {
    await sql`UPDATE live_chats SET block_timer_seconds = 0, awaiting_reply_since = NULL WHERE id = ${chatId}`
  } else {
    await sql`UPDATE live_chats SET block_timer_seconds = ${seconds} WHERE id = ${chatId}`
  }
}

/** Called after an admin message. Starts the countdown only if the timer is
 *  on, Extra Security is on, and no countdown is already running. It does
 *  not restart on every message, so the admin can't keep pushing the
 *  deadline back by sending more messages. */
export async function armBlockTimer(chatId: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET awaiting_reply_since = ${Date.now()}
    WHERE id = ${chatId} AND security_enabled = TRUE AND block_timer_seconds > 0
      AND status != 'closed' AND blocked_at IS NULL AND awaiting_reply_since IS NULL`
}

/** Called when the visitor sends a message. Stops the countdown. */
export async function clearAwaitingReply(chatId: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET awaiting_reply_since = NULL WHERE id = ${chatId} AND awaiting_reply_since IS NOT NULL`
}

function timerDeadline(row: any): number | null {
  if (!row?.block_timer_seconds || !row?.awaiting_reply_since) return null
  return Number(row.awaiting_reply_since) + Number(row.block_timer_seconds) * 1000
}

/** Blocks the chat's visitor device: closes the chat, records the block (device
 *  cookie + fingerprint), and only ever flips a chat once. Concurrent polls
 *  can't create two blocks. */
async function blockChatVisitor(row: any) {
  const now = Date.now()
  // The chat stays open: it is only closed when the visitor enters the chat password.
  const flipped = await sql`UPDATE live_chats SET blocked_at = ${now},
      blocked_reason = ${BLOCK_REASON_NO_REPLY}, blocked_dismissed_at = NULL,
      awaiting_reply_since = NULL, updated_at = ${now}
    WHERE id = ${row.id} AND blocked_at IS NULL RETURNING id`
  if (!flipped.length) return false
  const blockId = `blk_${now}_${Math.random().toString(36).slice(2, 9)}`
  await sql`INSERT INTO live_chat_device_blocks (id, device_id, fingerprint, chat_id, reason, blocked_at, active)
    VALUES (${blockId}, ${row.device_id || ''}, ${row.device_fingerprint || ''}, ${row.id}, ${BLOCK_REASON_NO_REPLY}, ${now}, TRUE)`
  return true
}

/** Checks one chat's reply timer. If the deadline has passed, the visitor is
 *  blocked. Safe to call on every poll: it's a no-op unless the deadline has
 *  passed. Returns whether this chat is blocked now, and whether this call
 *  is the one that blocked it. */
export async function enforceBlockTimer(chatId: string): Promise<{ blocked: boolean; newlyBlocked: boolean }> {
  await ensureLiveChatSchema()
  const row = (await sql`SELECT id, device_id, device_fingerprint, status, block_timer_seconds,
      awaiting_reply_since, blocked_at FROM live_chats WHERE id = ${chatId}`)[0]
  if (!row) return { blocked: false, newlyBlocked: false }
  if (row.blocked_at) return { blocked: true, newlyBlocked: false }
  const deadline = timerDeadline(row)
  if (!deadline || row.status === 'closed' || Date.now() < deadline) return { blocked: false, newlyBlocked: false }
  const newly = await blockChatVisitor(row)
  return { blocked: true, newlyBlocked: newly }
}

/** Runs the reply-timer check for every chat that has a countdown running.
 *  Called from the admin list, so a missed reply gets blocked promptly even
 *  if the visitor's tab is closed. Returns the ids of chats blocked now. */
export async function enforceAllBlockTimers(): Promise<string[]> {
  await ensureLiveChatSchema()
  const rows = await sql`SELECT id, device_id, device_fingerprint, status, block_timer_seconds,
      awaiting_reply_since, blocked_at FROM live_chats
    WHERE block_timer_seconds > 0 AND awaiting_reply_since IS NOT NULL AND status != 'closed' AND blocked_at IS NULL`
  const now = Date.now()
  const blockedIds: string[] = []
  for (const row of rows) {
    const deadline = timerDeadline(row)
    if (deadline && now >= deadline && await blockChatVisitor(row)) blockedIds.push(row.id)
  }
  return blockedIds
}

/** Runs the reply-timer check for the chats that belong to this device (by cookie
 *  or fingerprint). A visitor who went quiet and comes back to the site is blocked
 *  here, before the gate reads the device block. */
export async function enforceBlockTimersForDevice(deviceId: string, fingerprint: string) {
  await ensureLiveChatSchema()
  const fp = (fingerprint || '').slice(0, 64)
  const rows = await sql`SELECT id, device_id, device_fingerprint, status, block_timer_seconds,
      awaiting_reply_since, blocked_at FROM live_chats
    WHERE block_timer_seconds > 0 AND awaiting_reply_since IS NOT NULL AND status != 'closed' AND blocked_at IS NULL
      AND ((device_id <> '' AND device_id = ${deviceId || ''}) OR (${fp} <> '' AND device_fingerprint = ${fp}))`
  const now = Date.now()
  for (const row of rows) {
    const deadline = timerDeadline(row)
    if (deadline && now >= deadline) await blockChatVisitor(row)
  }
}

/** Is this device blocked from the website? Matches the signed device cookie
 *  OR the browser fingerprint, and never the IP address. */
export async function getDeviceBlock(deviceId: string, fingerprint: string) {
  await ensureLiveChatSchema()
  const fp = (fingerprint || '').slice(0, 64)
  const rows = await sql`SELECT b.reason, b.blocked_at, b.chat_id, c.blocked_dismissed_at AS dismissed_at
    FROM live_chat_device_blocks b
    LEFT JOIN live_chats c ON c.id = b.chat_id
    WHERE b.active = TRUE AND (
      (b.device_id <> '' AND b.device_id = ${deviceId || ''})
      OR (${fp} <> '' AND b.fingerprint = ${fp})
    )
    ORDER BY b.blocked_at DESC LIMIT 1`
  if (!rows.length) return null
  return {
    reason: rows[0].reason as string,
    blockedAt: Number(rows[0].blocked_at),
    chatId: (rows[0].chat_id as string) || null,
    dismissed: !!rows[0].dismissed_at,
  }
}

/** Admin lifts a visitor's block. Ends every active block on this chat's device,
 *  clears the chat's blocked state, and reopens the chat so the visitor can
 *  pick the conversation back up. */
export async function unblockChatVisitor(chatId: string) {
  await ensureLiveChatSchema()
  const now = Date.now()
  // Only a chat that the visitor or the admin actually ended stays ended.
  const before = (await sql`SELECT ended_by_user, ended_by_admin FROM live_chats WHERE id = ${chatId}`)[0]
  const closedByVisitor = !!before?.ended_by_user || !!before?.ended_by_admin
  await sql`UPDATE live_chat_device_blocks SET active = FALSE, unblocked_at = ${now}
    WHERE chat_id = ${chatId} AND active = TRUE`
  await sql`UPDATE live_chats SET blocked_at = NULL, blocked_reason = NULL, blocked_dismissed_at = NULL WHERE id = ${chatId}`
  // A chat that was explicitly ended stays ended. Otherwise it's open again.
  if (!closedByVisitor) await reopenChat(chatId, true)
}

/** Visitor unblocks their own device with the "I know Abhishek personally" check.
 *  Lifts every active device block for this device or fingerprint. Returns the
 *  chat ids that were unblocked. */
export async function selfUnblockDevice(deviceId: string, fingerprint: string): Promise<string[]> {
  await ensureLiveChatSchema()
  const fp = (fingerprint || '').slice(0, 64)
  const rows = (await sql`SELECT DISTINCT chat_id FROM live_chat_device_blocks
    WHERE active = TRUE AND chat_id IS NOT NULL AND (
      (device_id <> '' AND device_id = ${deviceId || ''})
      OR (${fp} <> '' AND fingerprint = ${fp})
    )`) as any[]
  const chatIds = rows.map(r => r.chat_id as string)
  for (const id of chatIds) await unblockChatVisitor(id)
  return chatIds
}

/** The visitor hides the blocked notice on this device by entering the password.
 *  This does NOT end the chat. Only the visitor or the admin can end it. The
 *  flag keeps the notice hidden on refresh, until the block is lifted. */
export async function dismissBlockedChat(chatId: string) {
  await ensureLiveChatSchema()
  const now = Date.now()
  await sql`UPDATE live_chats SET blocked_dismissed_at = ${now}, updated_at = ${now} WHERE id = ${chatId}`
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-delete ("retention"). One setting per chat, set by either side. The
// purge deletes messages that have become due. Voice notes and kept
// photos/videos (Chat Media) are never auto-deleted.
// ─────────────────────────────────────────────────────────────────────────

export async function setRetention(
  chatId: string,
  mode: 'seen' | '24h' | '7d' | 'never',
  by: 'user' | 'admin',
  seenDelaySeconds = 0,
) {
  await ensureLiveChatSchema()
  const now = Date.now()
  const delay = mode === 'seen' ? seenDelaySeconds : 0
  await sql`UPDATE live_chats SET retention = ${mode}, retention_seen_delay = ${delay}, retention_set_by = ${by},
      retention_set_at = ${now}, updated_at = ${now}
    WHERE id = ${chatId}`
}

export async function getRetention(chatId: string): Promise<string> {
  await ensureLiveChatSchema()
  const row = (await sql`SELECT retention FROM live_chats WHERE id = ${chatId}`)[0]
  return row?.retention || 'never'
}

/** Deletes one chat's messages that are due under its auto-delete setting.
 *  Returns the ids that were removed, so the caller can tell both sides. */
export async function purgeChatMessages(chatId: string): Promise<string[]> {
  await ensureLiveChatSchema()
  const now = Date.now()
  const rows = await sql`DELETE FROM live_chat_messages m
    USING live_chats c
    WHERE c.id = m.chat_id AND m.chat_id = ${chatId}
      AND c.retention <> 'never'
      AND m.media_keep = FALSE AND COALESCE(m.media_type, '') <> 'audio'
      AND (
        (c.retention = 'seen' AND m.status = 'read' AND m.read_at IS NOT NULL
          AND m.read_at + c.retention_seen_delay * 1000 <= ${now})
        OR (c.retention = '24h' AND m.created_at < ${now - DAY_MS})
        OR (c.retention = '7d' AND m.created_at < ${now - WEEK_MS})
      )
    RETURNING m.id`
  return rows.map((r: any) => r.id as string)
}

let lastGlobalPurgeAt = 0
const GLOBAL_PURGE_EVERY_MS = 60_000

/** Runs the auto-delete purge across all chats. Throttled to once a minute per
 *  server instance. Returns removed message ids grouped by chat id. */
export async function purgeAllDueMessages(): Promise<Record<string, string[]>> {
  const now = Date.now()
  if (now - lastGlobalPurgeAt < GLOBAL_PURGE_EVERY_MS) return {}
  lastGlobalPurgeAt = now
  await ensureLiveChatSchema()
  const rows = await sql`DELETE FROM live_chat_messages m
    USING live_chats c
    WHERE c.id = m.chat_id
      AND c.retention <> 'never'
      AND m.media_keep = FALSE AND COALESCE(m.media_type, '') <> 'audio'
      AND (
        (c.retention = 'seen' AND m.status = 'read' AND m.read_at IS NOT NULL
          AND m.read_at + c.retention_seen_delay * 1000 <= ${now})
        OR (c.retention = '24h' AND m.created_at < ${now - DAY_MS})
        OR (c.retention = '7d' AND m.created_at < ${now - WEEK_MS})
      )
    RETURNING m.id, m.chat_id`
  const grouped: Record<string, string[]> = {}
  for (const r of rows as any[]) {
    (grouped[r.chat_id] ||= []).push(r.id)
  }
  return grouped
}

/** Records who is handling the chat (the real admin or a co-admin). */
export async function setAgent(chatId: string, name: string, role: 'admin' | 'coadmin') {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chats SET agent_name = ${name}, agent_role = ${role}, agent_at = ${Date.now()} WHERE id = ${chatId}`
}

/** Stores the display name of whoever sent an admin-side message. */
export async function setMessageSenderName(messageId: string, name: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chat_messages SET sender_name = ${name} WHERE id = ${messageId}`
}

/** True when the real admin has this chat open and visible right now. Push notifications
 *  for messages are skipped in that case, since the admin is already looking at them. */
export async function isAdminViewingChat(chatId: string): Promise<boolean> {
  await ensureLiveChatSchema()
  const row = (await sql`SELECT in_chat, last_active FROM live_chat_presence WHERE chat_id = ${chatId} AND role = 'admin'`)[0]
  return !!row?.in_chat && Date.now() - Number(row.last_active) < 20_000
}

/** Stores the fetched link preview (JSON) on a message. */
export async function setMessageLinkPreview(messageId: string, json: string) {
  await ensureLiveChatSchema()
  await sql`UPDATE live_chat_messages SET link_preview = ${json} WHERE id = ${messageId}`
}

export { RECENT_MESSAGE_LIMIT }
