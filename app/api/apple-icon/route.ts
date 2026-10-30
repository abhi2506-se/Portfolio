import { NextResponse } from 'next/server'
import { lazySql as sql } from '@/lib/neon-lazy'

/**
 * GET /api/apple-icon
 * The icon iPhone uses when the site or admin panel is added to the Home Screen.
 * It serves the logo uploaded from the admin panel. If nothing has been uploaded
 * yet, it falls back to the static /apple-touch-icon.png.
 */
export async function GET(req: Request) {
  try {
    const rows = (await sql`SELECT value FROM site_settings WHERE key = 'apple_icon_url'`) as any[]
    const url = rows[0]?.value as string | undefined
    if (url) {
      const upstream = await fetch(url)
      if (upstream.ok) {
        const buffer = await upstream.arrayBuffer()
        return new NextResponse(buffer, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
          },
        })
      }
    }
  } catch (e) {
    console.error('GET /api/apple-icon error:', e)
  }
  return NextResponse.redirect(new URL('/apple-touch-icon.png', req.url))
}
