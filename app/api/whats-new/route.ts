import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/admin-auth'
import { listSiteUpdates, createSiteUpdate, deleteSiteUpdate } from '@/lib/site-updates-db'
// Written by scripts/generate-whats-new.mjs on every build (new pages and features).
import generated from '@/lib/whats-new.generated.json'

const SESSION_COOKIE = 'portfolio_admin_session'
const noStore = { 'Cache-Control': 'no-store, max-age=0' }

function isAdmin(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE)
  return !!cookie?.value && verifyToken(cookie.value)
}

/** GET: public, always read from the database, never cached. */
export async function GET() {
  try {
    const manual = (await listSiteUpdates()).map(u => ({ id: u.id, title: u.title, body: u.body, created_at: Number(u.created_at) }))
    const auto = (generated.items || []).map((g: any) => ({
      id: g.id, title: g.title, body: g.body || '', created_at: Date.parse(g.date) || Date.parse(generated.generatedAt) || 0,
    }))
    // Automatic entries (new features found at build time) and manual admin entries, newest first.
    const items = [...auto, ...manual].sort((a, b) => b.created_at - a.created_at).slice(0, 60)
    return NextResponse.json({ items }, { headers: noStore })
  } catch (e) {
    console.error('GET /api/whats-new error:', e)
    return NextResponse.json({ items: [], error: 'Could not load updates.' }, { status: 500, headers: noStore })
  }
}

/** POST: admin adds an entry. */
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const title = String(body.title || '').trim().slice(0, 120)
  const text = String(body.body || '').trim().slice(0, 2000)
  if (!title) return NextResponse.json({ error: 'Title is required.' }, { status: 400 })
  const item = await createSiteUpdate(title, text)
  return NextResponse.json({ item }, { headers: noStore })
}

/** DELETE: admin removes an entry. */
export async function DELETE(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = req.nextUrl.searchParams.get('id') || ''
  if (!id) return NextResponse.json({ error: 'Missing id.' }, { status: 400 })
  await deleteSiteUpdate(id)
  return NextResponse.json({ ok: true }, { headers: noStore })
}
