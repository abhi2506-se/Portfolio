/** Where a site badge can appear. Add a new value here and a <SiteBadges placement="..."/> slot where it should show. */
export const SITE_BADGE_PLACEMENTS = [
  { value: 'footer', label: 'Footer (under the brand text)' },
  { value: 'hero', label: 'Hero (under the buttons)' },
] as const

export type SiteBadgePlacement = (typeof SITE_BADGE_PLACEMENTS)[number]['value']

export function isSiteBadgePlacement(v: unknown): v is SiteBadgePlacement {
  return typeof v === 'string' && SITE_BADGE_PLACEMENTS.some(p => p.value === v)
}

export interface SiteBadge {
  id: string
  title: string
  href: string
  imageUrl: string
  placements: SiteBadgePlacement[]
  enabled: boolean
}
