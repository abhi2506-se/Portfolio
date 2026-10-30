import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/admin-auth'
import { CO_ADMIN_SESSION_COOKIE, verifyCoAdminToken } from '@/lib/co-admin-auth'
import { getOrCreateDeviceId, attachDeviceCookie } from '@/lib/device-id'
import { enforceBlockTimersForDevice, getDeviceBlock, getChatPasswordHash } from '@/lib/live-chat-db'

const SESSION_COOKIE = 'portfolio_admin_session'

function isAdminAuthed(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE)
  if (cookie?.value && verifyToken(cookie.value)) return true
  const coCookie = req.cookies.get(CO_ADMIN_SESSION_COOKIE)
  const coPayload = coCookie?.value ? verifyCoAdminToken(coCookie.value) : null
  return !!coPayload && coPayload.permissions.includes('live_chat')
}

/**
 * GET /api/live-chat/block-status?fp=<browser fingerprint>
 *
 * Tells the public site whether this device is currently blocked from it
 * because it missed a live-chat reply. The admin panel is never blocked, and
 * the site (outside live chat) is never blocked for devices with no block.
 * The block is matched by the signed device cookie or the browser fingerprint.
 * IP addresses are never used.
 */
export async function GET(req: NextRequest) {
  try {
    const { deviceId, isNew, token } = getOrCreateDeviceId(req)
    const respond = (body: Record<string, unknown>) => {
      const res = NextResponse.json(body)
      return isNew ? attachDeviceCookie(res, token) : res
    }

    if (isAdminAuthed(req)) return respond({ blocked: false })

    const fp = (req.nextUrl.searchParams.get('fp') || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)

    // Run any expired reply timers for this device first, so a visitor who
    // went quiet gets blocked the moment they come back to the site.
    await enforceBlockTimersForDevice(deviceId, fp)

    const block = await getDeviceBlock(deviceId, fp)
    if (!block) return respond({ blocked: false })
    // The blocked chat stays open for the visitor until they close it with the
    // password. The gate uses these fields to show that chat again after a refresh.
    const passwordRequired = block.chatId && !block.dismissed ? !!(await getChatPasswordHash(block.chatId)) : false
    return respond({
      blocked: true,
      reason: block.reason,
      blockedAt: block.blockedAt,
      chatId: block.chatId,
      chatDismissed: block.dismissed,
      passwordRequired,
    })
  } catch (e) {
    console.error('[live-chat] block-status error:', e)
    // Fail open: a server hiccup must never lock everyone out of the site.
    return NextResponse.json({ blocked: false })
  }
}
