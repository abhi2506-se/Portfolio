import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/admin-auth'
import { listSiteBadges, createSiteBadge, setSiteBadgeEnabled, deleteSiteBadge } from '@/lib/site-badges-db'
import { isSiteBadgePlacement, type SiteBadgePlacement } from '@/lib/site-badge-placements'

const noStore = { 'Cache-Control': 'no-store, max-age=0' }

function isAdmin(req: NextRequest) {
  const cookie = req.cookies.get('portfolio_admin_session')
  return !!cookie?.value && verifyToken(cookie.value)
}

function isHttpUrl(v: string) {
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}

/** GET: enabled badges for the public site. ?all=1 (admin only) returns disabled ones too. */
export async function GET(req: NextRequest) {
  const all = req.nextUrl.searchParams.get('all') === '1'
  if (all && !isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const items = await listSiteBadges(!all)
  return NextResponse.json({ items }, { headers: noStore })
}

/** POST: admin adds a badge. */
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const title = String(body.title || '').trim().slice(0, 80)
  const href = String(body.href || '').trim()
  const imageUrl = String(body.imageUrl || '').trim()
  const placements = (Array.isArray(body.placements) ? body.placements : []).filter(isSiteBadgePlacement) as SiteBadgePlacement[]
  if (!title) return NextResponse.json({ error: 'Name is required.' }, { status: 400 })
  if (!isHttpUrl(href)) return NextResponse.json({ error: 'Enter a valid link (https://...).' }, { status: 400 })
  if (!isHttpUrl(imageUrl)) return NextResponse.json({ error: 'Add a logo image.' }, { status: 400 })
  if (placements.length === 0) return NextResponse.json({ error: 'Choose at least one location.' }, { status: 400 })
  await createSiteBadge({ title, href, imageUrl, placements: Array.from(new Set(placements)) })
  return NextResponse.json({ ok: true }, { headers: noStore })
}

/** PATCH: admin turns a badge on or off. */
export async function PATCH(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  if (!body.id || typeof body.enabled !== 'boolean') return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  await setSiteBadgeEnabled(String(body.id), body.enabled)
  return NextResponse.json({ ok: true }, { headers: noStore })
}

/** DELETE: admin removes a badge. */
export async function DELETE(req: NextRequest) {
  if (!isAdmin(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = req.nextUrl.searchParams.get('id') || ''
  if (!id) return NextResponse.json({ error: 'Missing id.' }, { status: 400 })
  await deleteSiteBadge(id)
  return NextResponse.json({ ok: true }, { headers: noStore })
}
