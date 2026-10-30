/**
 * lib/link-preview.ts  (SERVER ONLY)
 *
 * Fetches a link's title, description, and image once, when a live chat message
 * containing it is sent, so every reader sees the same preview.
 *
 * Safety: only http/https, every hop is checked against private, loopback and
 * link-local addresses (SSRF), at most 3 redirects, a 4 second timeout, and at
 * most 512 KB is read.
 */
import { lookup } from 'dns/promises'
import net from 'net'

export interface LinkPreview {
  url: string
  title: string
  description: string
  image: string | null
  siteName: string
}

const URL_RE = /https?:\/\/[^\s<>"']+/i

export function extractFirstUrl(text: string): string | null {
  const m = (text || '').match(URL_RE)
  if (!m) return null
  return m[0].replace(/[),.;!?]+$/, '')
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase()
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')
      || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.')
  }
  return true
}

async function assertPublicHost(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
  const addrs = await lookup(url.hostname, { all: true })
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('private address')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

function readMeta(html: string, keys: string[]): string | null {
  for (const tag of html.match(/<meta\s[^>]*>/gi) || []) {
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] || '').toLowerCase()
    if (!keys.includes(key)) continue
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1]
    if (content) return decodeEntities(content)
  }
  return null
}

async function readLimited(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < max) {
    const { done, value } = await reader.read()
    if (done || !value) break
    chunks.push(value)
    total += value.byteLength
  }
  reader.cancel().catch(() => {})
  return new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))))
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
  let url = new URL(rawUrl)
  for (let hop = 0; hop < 3; hop++) {
    await assertPublicHost(url)
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortfolioLinkPreview/1.0)', Accept: 'text/html' },
    })
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url)
      continue
    }
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return null
    const html = await readLimited(res, 512 * 1024)
    const title = readMeta(html, ['og:title', 'twitter:title'])
      || decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '')
      || url.hostname
    const description = readMeta(html, ['og:description', 'twitter:description', 'description']) || ''
    const imgRaw = readMeta(html, ['og:image', 'twitter:image'])
    let image: string | null = null
    if (imgRaw) {
      try { image = new URL(imgRaw, url).toString() } catch {}
    }
    const siteName = readMeta(html, ['og:site_name']) || url.hostname
    return {
      url: rawUrl,
      title: title.slice(0, 200),
      description: description.slice(0, 300),
      image,
      siteName: siteName.slice(0, 100),
    }
  }
  return null
}
