'use client'

/**
 * lib/client-fingerprint.ts
 *
 * Browser fingerprint used to recognise a device that has been blocked from
 * the website. It reads the SAME localStorage key ('__fp_id') as the existing
 * SuspiciousActivityDetector, so the two features always agree on which
 * device is which. If that key is already there, it is reused; otherwise a
 * fresh hash is computed from stable browser traits and stored.
 */

const FP_KEY = '__fp_id'
let cached: string | null = null
let pending: Promise<string> | null = null

async function computeFingerprint(): Promise<string> {
  const parts: string[] = []
  parts.push(navigator.userAgent)
  parts.push(`${screen.width}x${screen.height}x${screen.colorDepth}`)
  parts.push(navigator.language || '')
  parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || '')
  parts.push(String(navigator.hardwareConcurrency || 0))
  parts.push(String((navigator as any).deviceMemory || 0))
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.textBaseline = 'top'
      ctx.font = '14px Arial'
      ctx.fillStyle = '#f60'
      ctx.fillRect(125, 1, 62, 20)
      ctx.fillStyle = '#069'
      ctx.fillText('Fingerprint🔒', 2, 15)
      ctx.fillStyle = 'rgba(102,204,0,0.7)'
      ctx.fillText('Fingerprint🔒', 4, 17)
      parts.push(canvas.toDataURL().slice(-50))
    }
  } catch {}
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export async function getClientFingerprint(): Promise<string> {
  if (cached) return cached
  try {
    const stored = localStorage.getItem(FP_KEY)
    if (stored && stored.length > 10) { cached = stored; return stored }
  } catch {}
  if (!pending) {
    pending = computeFingerprint()
      .then(fp => {
        cached = fp
        try { localStorage.setItem(FP_KEY, fp) } catch {}
        return fp
      })
      .catch(() => {
        const fallback = Math.random().toString(36).slice(2) + Date.now().toString(36)
        cached = fallback
        return fallback
      })
      .finally(() => { pending = null })
  }
  return pending
}
