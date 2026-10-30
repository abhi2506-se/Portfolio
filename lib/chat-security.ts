/**
 * lib/chat-security.ts  (SERVER ONLY — imports Node crypto)
 *
 * Helpers for the per-chat "Extra Security" password:
 *   - hashing / verifying the password (scrypt — built into Node, no new deps)
 *   - a small wrong-password limiter so the visitor prompt can't be brute-forced
 *   - a sanitizer that strips the password hash from any chat row before it
 *     is sent to a browser
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

const KEY_LEN = 32

/** Returns "scrypt$<saltHex>$<hashHex>" — safe to store in the DB. */
export async function hashChatPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEY_LEN)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyChatPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// ── Wrong-password limiter (in-memory, per chat + device) ───────────────────
// Five wrong guesses locks that device out of that chat's password prompt for
// ten minutes. Kept in memory, so it resets on a cold start — good enough to
// stop casual guessing without adding a new table.
const MAX_WRONG = 5
const LOCK_MS = 10 * 60_000
const attempts = new Map<string, { wrong: number; lockedUntil: number }>()

export function passwordAttemptLocked(key: string): number {
  const rec = attempts.get(key)
  if (!rec) return 0
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return rec.lockedUntil - Date.now()
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) attempts.delete(key)
  return 0
}

export function recordWrongPassword(key: string) {
  const rec = attempts.get(key) || { wrong: 0, lockedUntil: 0 }
  rec.wrong += 1
  if (rec.wrong >= MAX_WRONG) {
    rec.lockedUntil = Date.now() + LOCK_MS
    rec.wrong = 0
  }
  attempts.set(key, rec)
}

export function clearWrongPasswords(key: string) {
  attempts.delete(key)
}

// ── Sanitizer ───────────────────────────────────────────────────────────────
/** Removes the password hash and exposes only a boolean "has password". */
export function sanitizeChat<T extends Record<string, any>>(chat: T): T {
  if (!chat) return chat
  const { security_password_hash, ...rest } = chat as any
  return { ...rest, security_has_password: !!security_password_hash } as T
}

export function sanitizeChats(chats: any): any[] {
  return (Array.isArray(chats) ? chats : []).map(c => sanitizeChat(c))
}
