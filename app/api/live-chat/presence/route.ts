import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/admin-auth'
import { CO_ADMIN_SESSION_COOKIE, verifyCoAdminToken } from '@/lib/co-admin-auth'
import { getOrCreateDeviceId, attachDeviceCookie } from '@/lib/device-id'
import { heartbeat, getPresence, isChatSecured, isChatLockedForDevice } from '@/lib/live-chat-db'
import { isRealAdminRequest } from '@/lib/live-chat-auth'

// What a visitor sees for the admin on an Extra Security chat they have not unlocked.
const HIDDEN_ADMIN = { status: 'offline' as const, awaySeconds: 0, lastActiveAt: null, hidden: true }
import { broadcastToChat } from '@/lib/supabase-realtime'

const SESSION_COOKIE = 'portfolio_admin_session'

function isAdminAuthed(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE)
  if (cookie?.value && verifyToken(cookie.value)) return true
  const coCookie = req.cookies.get(CO_ADMIN_SESSION_COOKIE)
  const coPayload = coCookie?.value ? verifyCoAdminToken(coCookie.value) : null
  return !!coPayload && coPayload.permissions.includes('live_chat')
}

// POST { chatId, active } — call every ~10s from the client while a chat is open,
// and immediately on visibility/focus change. `active` = tab visible + focused +
// recent interaction (see hooks/use-presence.ts).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { chatId, active, role: claimedRole } = body
    if (!chatId) return NextResponse.json({ error: 'Missing chatId' }, { status: 400 })

    // The caller (admin panel vs public widget) already knows which role it
    // is — trust that claim, but only let it through as 'admin' if the
    // session cookie actually validates. This avoids silently mis-recording
    // an admin heartbeat as 'user' (or vice versa) whenever cookie inference
    // alone gets it wrong, which is what was breaking online/offline/last
    // seen and read receipts on the admin side.
    const admin = isAdminAuthed(req)
    const role: 'user' | 'admin' = claimedRole === 'admin' ? (admin ? 'admin' : 'user') : 'user'
    const { deviceId, isNew, token } = getOrCreateDeviceId(req)

    // A co-admin doesn't record the admin's presence on a chat. That presence belongs to the real admin.
    if (role === 'admin' && !isRealAdminRequest(req)) {
      return NextResponse.json({ ok: true, presence: await getPresence(chatId) })
    }
    const presence = await heartbeat(chatId, role, !!active)
    // Admin presence is not broadcast on Extra Security chats: a visitor on the
    // channel would see it without entering the password.
    const secured = await isChatSecured(chatId)
    if (!(role === 'admin' && secured)) {
      broadcastToChat(chatId, 'presence', { role, ...presence[role] }).catch(() => {})
    }
    // The heartbeat response includes admin presence, so hide it from a locked visitor too.
    const locked = !admin && await isChatLockedForDevice(chatId, deviceId)
    const outPresence = locked ? { ...presence, admin: HIDDEN_ADMIN } : presence

    const res = NextResponse.json({ ok: true, presence: outPresence })
    return isNew && !admin ? attachDeviceCookie(res, token) : res
  } catch (e) {
    console.error('[presence] POST error:', e)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

// GET ?chatId=... — polling fallback for presence status
export async function GET(req: NextRequest) {
  try {
    const chatId = new URL(req.url).searchParams.get('chatId')
    if (!chatId) return NextResponse.json({ error: 'Missing chatId' }, { status: 400 })
    const presence = await getPresence(chatId)
    // A visitor on a locked Extra Security chat doesn't see admin presence.
    const { deviceId } = getOrCreateDeviceId(req)
    const locked = !isAdminAuthed(req) && await isChatLockedForDevice(chatId, deviceId)
    return NextResponse.json({ presence: locked ? { ...presence, admin: HIDDEN_ADMIN } : presence })
  } catch (e) {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
