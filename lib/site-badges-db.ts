/** SERVER ONLY. Badges that the admin adds from /admin/badges. */
import { lazySql as sql } from '@/lib/neon-lazy'
import { isSiteBadgePlacement, type SiteBadge, type SiteBadgePlacement } from '@/lib/site-badge-placements'

let ensured = false
async function ensureTable() {
  if (ensured) return
  await sql`CREATE TABLE IF NOT EXISTS site_badges (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    href TEXT NOT NULL,
    image_url TEXT NOT NULL,
    placements TEXT NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL
  )`
  ensured = true
}

function toBadge(r: any): SiteBadge {
  const placements = String(r.placements || '').split(',').filter(isSiteBadgePlacement) as SiteBadgePlacement[]
  return { id: r.id, title: r.title, href: r.href, imageUrl: r.image_url, placements, enabled: !!r.enabled }
}

export async function listSiteBadges(onlyEnabled: boolean): Promise<SiteBadge[]> {
  await ensureTable()
  const rows = onlyEnabled
    ? ((await sql`SELECT * FROM site_badges WHERE enabled = TRUE ORDER BY created_at ASC`) as any[])
    : ((await sql`SELECT * FROM site_badges ORDER BY created_at ASC`) as any[])
  return rows.map(toBadge)
}

export async function createSiteBadge(input: { title: string; href: string; imageUrl: string; placements: SiteBadgePlacement[] }) {
  await ensureTable()
  const now = Date.now()
  const id = `badge_${now}_${Math.random().toString(36).slice(2, 8)}`
  await sql`INSERT INTO site_badges (id, title, href, image_url, placements, enabled, created_at)
    VALUES (${id}, ${input.title}, ${input.href}, ${input.imageUrl}, ${input.placements.join(',')}, TRUE, ${now})`
}

export async function setSiteBadgeEnabled(id: string, enabled: boolean) {
  await ensureTable()
  await sql`UPDATE site_badges SET enabled = ${enabled} WHERE id = ${id}`
}

export async function deleteSiteBadge(id: string) {
  await ensureTable()
  await sql`DELETE FROM site_badges WHERE id = ${id}`
}
