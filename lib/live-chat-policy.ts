/**
 * lib/live-chat-policy.ts
 *
 * Shared, CLIENT-SAFE rules for the Live Chat "Extra Security" and
 * "Auto-delete" features. Keep this file free of Node-only imports
 * (crypto, fs, ...) so both the API routes and the React components can
 * import it.
 */

// ── Auto-delete ("retention") ───────────────────────────────────────────────
// One setting per chat. Either the visitor or the admin can change it, and
// the chat follows whatever was chosen last.
//   seen  -> a message is deleted as soon as the other side has seen it
//   24h   -> a message is deleted 24 hours after it was sent
//   7d    -> a message is deleted 7 days after it was sent
//   never -> messages are kept forever (default)
export type RetentionMode = 'seen' | '24h' | '7d' | 'never'

export const RETENTION_MODES: RetentionMode[] = ['seen', '24h', '7d', 'never']

export const RETENTION_OPTIONS: { value: RetentionMode; label: string; hint: string }[] = [
  { value: 'seen', label: 'Delete after seen', hint: 'Each message disappears as soon as it has been read.' },
  { value: '24h', label: 'Delete after 24 hours', hint: 'Messages are removed 24 hours after they were sent.' },
  { value: '7d', label: 'Delete after 7 days', hint: 'Messages are removed 7 days after they were sent.' },
  { value: 'never', label: 'Never delete', hint: 'Keep the full conversation.' },
]

/**
 * Delay for "Delete after seen", in seconds. The clock starts when the other side
 * reads the message, so there is time to finish reading it. 0 = instantly.
 */
export const SEEN_DELAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Instantly' },
  { value: 5, label: '5 seconds' },
  { value: 10, label: '10 seconds' },
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '60 seconds' },
  { value: 120, label: '120 seconds' },
  { value: 300, label: '300 seconds' },
]

export function isSeenDelay(v: unknown): v is number {
  return typeof v === 'number' && SEEN_DELAY_OPTIONS.some(o => o.value === v)
}

export function isRetentionMode(v: unknown): v is RetentionMode {
  return typeof v === 'string' && (RETENTION_MODES as string[]).includes(v)
}

// ── Extra security: password + auto-block timer ─────────────────────────────
export const MIN_CHAT_PASSWORD_LENGTH = 4
export const MAX_CHAT_PASSWORD_LENGTH = 64

/** Seconds the visitor has to reply before their device is blocked. 0 = off. */
export const BLOCK_TIMER_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 180, label: '3 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
]

export function isValidBlockTimerSeconds(n: unknown): n is number {
  return typeof n === 'number' && BLOCK_TIMER_OPTIONS.some(o => o.value === n)
}

export function isValidChatPassword(pw: unknown): pw is string {
  return typeof pw === 'string'
    && pw.length >= MIN_CHAT_PASSWORD_LENGTH
    && pw.length <= MAX_CHAT_PASSWORD_LENGTH
}
