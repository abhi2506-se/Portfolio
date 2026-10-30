/**
 * lib/site-updates-db.ts  (SERVER ONLY)
 *
 * "What's new" entries. The admin adds them from /admin/whats-new, and the public
 * site fetches them live every time the list is opened, so new entries show up
 * without a deploy.
 */
import { lazySql as sql } from '@/lib/neon-lazy'

export interface SiteUpdate {
  id: string
  title: string
  body: string
  created_at: number
}

let ensured = false
async function ensureTable() {
  if (ensured) return
  await sql`CREATE TABLE IF NOT EXISTS site_updates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL
  )`
  ensured = true
}

export async function listSiteUpdates(limit = 50): Promise<SiteUpdate[]> {
  await ensureTable()
  return (await sql`SELECT id, title, body, created_at FROM site_updates ORDER BY created_at DESC LIMIT ${limit}`) as any[]
}

export async function createSiteUpdate(title: string, body: string): Promise<SiteUpdate> {
  await ensureTable()
  const now = Date.now()
  const id = `upd_${now}_${Math.random().toString(36).slice(2, 8)}`
  await sql`INSERT INTO site_updates (id, title, body, created_at) VALUES (${id}, ${title}, ${body}, ${now})`
  return { id, title, body, created_at: now }
}

export async function deleteSiteUpdate(id: string) {
  await ensureTable()
  await sql`DELETE FROM site_updates WHERE id = ${id}`
}
