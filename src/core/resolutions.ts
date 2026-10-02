// Pure helpers shared by the renderer and the exporter (no Node imports here).
import type { OutputResolution } from './types.ts'

export const RES_HEIGHT: Record<Exclude<OutputResolution, 'source'>, number> = {
  '720p': 720,
  '1080p': 1080,
  '1440p': 1440,
  '2160p': 2160,
}

export const RES_LABEL: Record<OutputResolution, string> = {
  source: 'Original',
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '2K · 1440p',
  '2160p': '4K · 2160p',
}

/** Resolutions that don't upscale the given source (compared on the short side). */
export function allowedResolutions(src: { width: number; height: number }): OutputResolution[] {
  const short = Math.min(src.width, src.height)
  const out: OutputResolution[] = []
  // A preset equal to the source size is the same as 'source' (which also skips scaling), so leave it out.
  for (const [k, h] of Object.entries(RES_HEIGHT)) if (h < short) out.push(k as OutputResolution)
  out.push('source')
  return out
}

export function targetSize(src: { width: number; height: number }, res: OutputResolution): { w: number; h: number } {
  if (res === 'source') return { w: src.width, h: src.height }
  const short = Math.min(src.width, src.height, RES_HEIGHT[res])
  const portrait = src.height > src.width
  const scale = short / (portrait ? src.width : src.height)
  return { w: Math.round((src.width * scale) / 2) * 2, h: Math.round((src.height * scale) / 2) * 2 }
}
