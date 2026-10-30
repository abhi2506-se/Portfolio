import { NextRequest, NextResponse } from 'next/server'
import { getOrCreateDeviceId, attachDeviceCookie } from '@/lib/device-id'
import { getVisitorPinHash, setVisitorPinHash } from '@/lib/visitor-lock-db'
import {
  hashChatPassword, verifyChatPassword, passwordAttemptLocked, recordWrongPassword, clearWrongPasswords,
} from '@/lib/chat-security'

const noStore = { 'Cache-Control': 'no-store, max-age=0' }
const PIN_RE = /^\d{4,8}$/

/**
 * GET: does this device have a lock PIN?
 * POST {action:'set', pin}: set or change the PIN for this device.
 * POST {action:'verify', pin}: unlock. Wrong guesses are limited per device.
 * The PIN only protects this device's screen. It doesn't identify anyone.
 */
export async function GET(req: NextRequest) {
  const { deviceId, isNew, token } = getOrCreateDeviceId(req)
  const res = NextResponse.json({ hasPin: !!(await getVisitorPinHash(deviceId)) }, { headers: noStore })
  return isNew ? attachDeviceCookie(res, token) : res
}

export async function POST(req: NextRequest) {
  const { deviceId, isNew, token } = getOrCreateDeviceId(req)
  const respond = (body: Record<string, unknown>, status = 200) => {
    const res = NextResponse.json(body, { status, headers: noStore })
    return isNew ? attachDeviceCookie(res, token) : res
  }
  const body = await req.json().catch(() => ({}))
  const pin = String(body.pin || '')
  if (!PIN_RE.test(pin)) return respond({ error: 'PIN must be 4 to 8 digits.' }, 400)

  if (body.action === 'set') {
    await setVisitorPinHash(deviceId, await hashChatPassword(pin))
    return respond({ ok: true })
  }

  if (body.action === 'verify') {
    const key = `vlock:${deviceId}`
    const waitMs = passwordAttemptLocked(key)
    if (waitMs) return respond({ error: `Too many wrong attempts. Try again in ${Math.ceil(waitMs / 60000)} minute(s).` }, 429)
    const hash = await getVisitorPinHash(deviceId)
    if (!hash) return respond({ error: 'No PIN is set on this device.' }, 404)
    if (!(await verifyChatPassword(pin, hash))) {
      recordWrongPassword(key)
      return respond({ error: 'Wrong PIN.' }, 403)
    }
    clearWrongPasswords(key)
    return respond({ ok: true })
  }

  return respond({ error: 'Unknown action.' }, 400)
}
