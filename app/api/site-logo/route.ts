import { NextRequest, NextResponse } from 'next/server'
import { lazySql as sql } from '@/lib/neon-lazy'
import { verifyToken } from '@/lib/admin-auth'

const KEY = 'site_logo_url'
const noStore = { 'Cache-Control': 'no-store, max-age=0' }

async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
}

function isAdmin(req: NextRequest) {
  const cookie = req.cookies.get('portfolio_admin_session')
  return !!cookie?.value && verifyToken(cookie.value)
}

/** GET: the current logo URL, or null when the text logo should be shown. */
export async function GET() {
  try {
    await ensureTable()
    const rows = (await sql`SELECT value FROM site_settings WHERE key = ${KEY}`) as any[]
    return NextResponse.json({ url: rows[0]?.value || null }, { headers: noStore })
  } catch (e) {
    console.error('GET /api/site-logo error:', e)
    return NextResponse.json({ url: null }, { headers: noStore })
  }
}

/** POST {url}: admin sets the logo. Empty url or DELETE: back to the text logo. */
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const url = String(body.url || '').trim()
  if (!/^https?:\/\//.test(url)) return NextResponse.json({ error: 'Invalid logo URL.' }, { status: 400 })
  await ensureTable()
  await sql`INSERT INTO site_settings (key, value) VALUES (${KEY}, ${url})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  return NextResponse.json({ ok: true }, { headers: noStore })
}

export async function DELETE(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await ensureTable()
  await sql`DELETE FROM site_settings WHERE key = ${KEY}`
  return NextResponse.json({ ok: true }, { headers: noStore })
}
