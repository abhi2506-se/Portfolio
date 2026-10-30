/** SERVER ONLY. Visitor-set PIN for locking their own device (not biometric). */
import { lazySql as sql } from '@/lib/neon-lazy'

let ensured = false
async function ensureTable() {
  if (ensured) return
  await sql`CREATE TABLE IF NOT EXISTS visitor_locks (
    device_id TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`
  ensured = true
}

export async function getVisitorPinHash(deviceId: string): Promise<string | null> {
  await ensureTable()
  const rows = (await sql`SELECT pin_hash FROM visitor_locks WHERE device_id = ${deviceId}`) as any[]
  return rows[0]?.pin_hash || null
}

export async function setVisitorPinHash(deviceId: string, pinHash: string) {
  await ensureTable()
  await sql`INSERT INTO visitor_locks (device_id, pin_hash, created_at) VALUES (${deviceId}, ${pinHash}, ${Date.now()})
    ON CONFLICT (device_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, created_at = EXCLUDED.created_at`
}
