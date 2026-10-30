'use client'

import { ExternalLink } from 'lucide-react'

/** Preview data stored on a message (see lib/link-preview.ts on the server). */
export interface LinkPreviewData {
  url: string
  title: string
  description: string
  image: string | null
  siteName: string
}

export function parseLinkPreview(raw?: string | null): LinkPreviewData | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    return data && typeof data.url === 'string' ? data : null
  } catch {
    return null
  }
}

const URL_SPLIT = /(https?:\/\/[^\s<>"']+)/gi

/** Renders text with every link as a clickable link that opens in a new tab. */
export function Linkified({ text, isMine }: { text: string; isMine: boolean }) {
  const parts = text.split(URL_SPLIT)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className={`underline break-all ${isMine ? 'text-white' : 'text-blue-500'}`}
          >
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

/** Card under a message: image, site name, title and description. The whole card opens the link. */
export function LinkPreviewCard({ preview, isMine }: { preview: LinkPreviewData; isMine: boolean }) {
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className={`mt-2 block overflow-hidden rounded-xl border hover:opacity-90 ${isMine ? 'border-white/25 bg-white/10' : 'border-border bg-background'}`}
    >
      {preview.image && (
        <img
          src={preview.image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
          className="w-full max-h-40 object-cover"
        />
      )}
      <div className="p-2.5 text-left">
        <p className="text-[11px] opacity-70 flex items-center gap-1 truncate">
          <ExternalLink className="w-3 h-3 shrink-0" />
          {preview.siteName}
        </p>
        <p className="text-sm font-semibold leading-snug line-clamp-2">{preview.title}</p>
        {preview.description && <p className="text-xs opacity-80 line-clamp-2 mt-0.5">{preview.description}</p>}
      </div>
    </a>
  )
}
