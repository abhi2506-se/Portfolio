import type { NextRequest } from 'next/server'
import { verifyToken } from '@/lib/admin-auth'

const SESSION_COOKIE = 'portfolio_admin_session'

/** True only for the real admin (the portfolio admin login), not a co-admin. */
export function isRealAdminRequest(req: NextRequest): boolean {
  const cookie = req.cookies.get(SESSION_COOKIE)
  return !!cookie?.value && verifyToken(cookie.value)
}
