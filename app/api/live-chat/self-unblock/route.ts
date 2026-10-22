import { NextRequest, NextResponse } from 'next/server'
import { getOrCreateDeviceId, attachDeviceCookie } from '@/lib/device-id'
import { selfUnblockDevice } from '@/lib/live-chat-db'
import { broadcastToChat } from '@/lib/supabase-realtime'
import { isSelfUnblockWifeName } from '@/lib/security-whitelist'
import { passwordAttemptLocked, recordWrongPassword, clearWrongPasswords } from '@/lib/chat-security'

/**
 * POST /api/live-chat/self-unblock
 * "I know Abhishek personally" flow for a device blocked by the live-chat reply
 * timer. Uses the same relation + name check as the site-wide self-unblock. Only
 * the blocked device's own live-chat blocks are lifted. The chat reopens for the
 * visitor, unless they had already ended it.
 */
export async function POST(req: NextRequest) {
  try {
    const { deviceId, isNew, token } = getOrCreateDeviceId(req)
    const respond = (body: Record<string, unknown>, status = 200) => {
      const res = NextResponse.json(body, { status })
      return isNew ? attachDeviceCookie(res, token) : res
    }

    const body = await req.json().catch(() => ({}))
    const { relation, name, fingerprint } = body as { relation?: string; name?: string; fingerprint?: string }
    const fp = (fingerprint || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)

    // Guessing names is rate limited per device.
    const key = `selfunblock:${deviceId}`
    const waitMs = passwordAttemptLocked(key)
    if (waitMs) {
      return respond({ unblocked: false, error: `Too many attempts. Try again in ${Math.ceil(waitMs / 60000)} minute(s).` }, 429)
    }

    if (relation !== 'wife' || !isSelfUnblockWifeName(name)) {
      recordWrongPassword(key)
      return respond({ unblocked: false, error: 'That name does not match our records.' })
    }
    clearWrongPasswords(key)

    const chatIds = await selfUnblockDevice(deviceId, fp)
    if (!chatIds.length) return respond({ unblocked: false, error: 'This device is not blocked.' })
    for (const id of chatIds) await broadcastToChat(id, 'chat_updated', { unblocked: true })
    return respond({ unblocked: true, chatIds })
  } catch (e) {
    console.error('[live-chat] self-unblock error:', e)
    return NextResponse.json({ unblocked: false, error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
