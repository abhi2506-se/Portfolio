'use client'

/**
 * lib/video-compress.ts
 *
 * Shrinks a video in the browser before it's sent in live chat.
 *
 * How it works: the video plays once, silently, while each frame is drawn to a
 * canvas at a smaller size (max 720px on the longest side). MediaRecorder encodes
 * the canvas, and the audio is taken from the video through an AudioContext. The
 * speed is real time, so a 1-minute clip takes about a minute to compress.
 *
 * Videos at or under COMPRESS_ABOVE_BYTES are sent as they are. If compression
 * fails, isn't supported, or doesn't make the file smaller, the original is used.
 */

/**
 * Vercel limits a request body to about 4.5 MB, so anything larger never reaches
 * the upload route. Videos are compressed to stay under MAX_SEND_BYTES.
 */
export const MAX_SEND_BYTES = 4 * 1024 * 1024
/** Videos up to this size are sent without compression. */
export const COMPRESS_ABOVE_BYTES = 3.5 * 1024 * 1024
/** Aim for this much output for the whole clip (kept under MAX_SEND_BYTES). */
const TARGET_OUTPUT_BYTES = 3.5 * 1024 * 1024
const MAX_SIDE = 720
/** Long clips drop to 480p so the bitrate stays usable. */
const LONG_CLIP_SECONDS = 120
const LONG_CLIP_MAX_SIDE = 480
const MIN_VIDEO_BPS = 120_000
const MAX_VIDEO_BPS = 2_500_000
const AUDIO_BPS = 96_000

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
  ]
  return candidates.find(c => MediaRecorder.isTypeSupported(c)) || null
}

function waitFor(el: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve() }
    const fail = () => { cleanup(); reject(new Error(`video ${event} failed`)) }
    const cleanup = () => {
      el.removeEventListener(event, ok)
      el.removeEventListener('error', fail)
    }
    el.addEventListener(event, ok)
    el.addEventListener('error', fail)
  })
}

/**
 * Returns a smaller version of the file when possible, otherwise the original file.
 * onProgress receives values from 0 to 1.
 */
export async function compressVideo(
  input: Blob,
  fileName: string,
  onProgress?: (fraction: number) => void,
): Promise<File> {
  const file = input instanceof File ? input : new File([input], fileName, { type: input.type })
  if (!file.type.startsWith('video/')) return file
  if (file.size <= COMPRESS_ABOVE_BYTES) return file

  const mimeType = pickMimeType()
  const AudioCtx: typeof AudioContext | undefined =
    typeof window !== 'undefined' ? (window.AudioContext || (window as any).webkitAudioContext) : undefined
  if (!mimeType || !AudioCtx || !document.createElement('canvas').captureStream) return file

  const objectUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.playsInline = true
  video.preload = 'auto'
  video.src = objectUrl

  let audioCtx: AudioContext | null = null
  let raf = 0
  try {
    await waitFor(video, 'loadedmetadata')
    const duration = video.duration
    if (!isFinite(duration) || duration <= 0 || !video.videoWidth || !video.videoHeight) return file

    const maxSide = duration > LONG_CLIP_SECONDS ? LONG_CLIP_MAX_SIDE : MAX_SIDE
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight))
    // Even dimensions are needed by most video encoders.
    const w = Math.max(2, Math.round(video.videoWidth * scale / 2) * 2)
    const h = Math.max(2, Math.round(video.videoHeight * scale / 2) * 2)

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file

    // Audio comes from the element through the Web Audio graph. It goes only into the
    // recorder, not to the speakers, so the user doesn't hear the compression.
    audioCtx = new AudioCtx()
    await audioCtx.resume().catch(() => {})
    const source = audioCtx.createMediaElementSource(video)
    const audioDest = audioCtx.createMediaStreamDestination()
    source.connect(audioDest)

    const videoTrack = canvas.captureStream(30).getVideoTracks()
    const stream = new MediaStream([...videoTrack, ...audioDest.stream.getAudioTracks()])

    const videoBps = Math.min(MAX_VIDEO_BPS, Math.max(MIN_VIDEO_BPS, Math.floor((TARGET_OUTPUT_BYTES * 8) / duration) - AUDIO_BPS))
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: videoBps,
      audioBitsPerSecond: AUDIO_BPS,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data) }
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve() })

    const draw = () => {
      ctx.drawImage(video, 0, 0, w, h)
      onProgress?.(Math.min(0.99, video.currentTime / duration))
      raf = requestAnimationFrame(draw)
    }

    recorder.start(1000)
    await video.play()
    draw()
    await waitFor(video, 'ended')
    cancelAnimationFrame(raf)
    // Give the encoder one last frame before stopping.
    ctx.drawImage(video, 0, 0, w, h)
    recorder.stop()
    await stopped

    const out = new Blob(chunks, { type: mimeType.split(';')[0] })
    if (!out.size || out.size >= file.size) return file
    onProgress?.(1)
    const ext = out.type.includes('mp4') ? 'mp4' : 'webm'
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'video'
    return new File([out], `${baseName}.${ext}`, { type: out.type })
  } catch {
    // Anything unexpected (e.g. autoplay blocked): send the original file.
    return file
  } finally {
    cancelAnimationFrame(raf)
    URL.revokeObjectURL(objectUrl)
    video.removeAttribute('src')
    video.load()
    audioCtx?.close().catch(() => {})
  }
}
