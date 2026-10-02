/**
 * Several recordings of one match (cameras split long recordings into ~4 GB files) played back to back as one
 * virtual timeline. Analysis runs and is cached per file; this module stitches the per-file results together
 * so segmentation sees one continuous match (a rally that straddles a file boundary stays one rally), and maps
 * timeline segments back to per-file clips for export.
 */
import type { AnalysisResult, Segment, SourceInfo } from './types.ts'

export interface Timeline {
  sources: SourceInfo[]
  /** Start of each source on the timeline (s). */
  offsets: number[]
  duration: number
}

export function makeTimeline(sources: SourceInfo[]): Timeline {
  const offsets: number[] = []
  let t = 0
  for (const s of sources) {
    offsets.push(t)
    t += s.durationSec
  }
  return { sources, offsets, duration: t }
}

/** Timeline time → which file and where in it. Times exactly on a boundary belong to the later file. */
export function toLocal(tl: Timeline, t: number): { index: number; t: number } {
  const tt = Math.max(0, Math.min(tl.duration, t))
  let i = tl.offsets.length - 1
  while (i > 0 && tl.offsets[i] > tt) i--
  return { index: i, t: Math.min(tt - tl.offsets[i], tl.sources[i].durationSec) }
}

export function toGlobal(tl: Timeline, index: number, t: number): number {
  return tl.offsets[index] + t
}

export interface FileClip {
  source: SourceInfo
  start: number
  end: number
}

/** Kept segments → per-file clips, split where a segment crosses from one file into the next. */
export function clipsForSegments(tl: Timeline, segs: { start: number; end: number }[], minLen = 0.3): FileClip[] {
  const out: FileClip[] = []
  for (const s of segs) {
    for (let i = 0; i < tl.sources.length; i++) {
      const a = Math.max(s.start, tl.offsets[i])
      const b = Math.min(s.end, tl.offsets[i] + tl.sources[i].durationSec)
      if (b - a >= minLen) out.push({ source: tl.sources[i], start: round3(a - tl.offsets[i]), end: round3(b - tl.offsets[i]) })
    }
  }
  return out
}

/**
 * Stitch per-file analyses into one result on the timeline. Frame-indexed features are shifted by each file's
 * offset in analysis frames; time-indexed ones by its offset in seconds. Geometry fields come from the first
 * file (split recordings share camera and resolution).
 */
export function combineAnalyses(tl: Timeline, parts: AnalysisResult[]): AnalysisResult {
  if (parts.length === 1) return parts[0]
  const first = parts[0]
  const fps = first.video.fps
  const motion: number[] = []
  const candidates: number[] = []
  const tracks: AnalysisResult['tracks'] = []
  const hits: { t: number; s: number }[] = []
  const onset: number[] = []
  const swings: NonNullable<AnalysisResult['poseEvents']>['swings'] = []
  const pickups: number[] = []
  let coverage = 0
  const hop = first.audio?.hop ?? 0.01
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const off = tl.offsets[i]
    const frameOff = Math.round(off * fps)
    // Pad/trim per-file arrays to their nominal length so later files line up exactly.
    const nFrames = Math.round(tl.sources[i].durationSec * fps)
    for (let k = 0; k < nFrames; k++) motion.push(p.video.motion[k] ?? 0)
    const c = p.video.candidates
    for (let k = 0; k < c.length; k += 5) candidates.push(c[k] + frameOff, c[k + 1], c[k + 2], c[k + 3], c[k + 4])
    for (const t of p.tracks) tracks.push({ ...t, start: t.start + frameOff, end: t.end + frameOff, points: t.points.map(([f, x, y]) => [f + frameOff, x, y]) })
    if (p.audio) {
      for (const h of p.audio.hits) hits.push({ t: round3(h.t + off), s: h.s })
      const n = Math.round(tl.sources[i].durationSec / hop)
      for (let k = 0; k < n; k++) onset.push(p.audio.onset[k] ?? 0)
    }
    if (p.poseEvents) {
      for (const s of p.poseEvents.swings) swings.push({ ...s, t: round3(s.t + off) })
      for (const t of p.poseEvents.pickups) pickups.push(round3(t + off))
      coverage += p.poseEvents.coverage * tl.sources[i].durationSec
    }
  }
  const anyPose = parts.some((p) => p.poseEvents)
  const anyAudio = parts.some((p) => p.audio)
  return {
    ...first,
    source: { ...first.source, durationSec: tl.duration, sizeBytes: tl.sources.reduce((s, x) => s + x.sizeBytes, 0) },
    video: { ...first.video, frameCount: motion.length, motion, candidates },
    audio: anyAudio ? { hop, onset, hits } : null,
    tracks,
    players: undefined,
    poseEvents: anyPose ? { swings, pickups, coverage: Math.round((coverage / tl.duration) * 100) / 100 } : undefined,
    elapsedSec: parts.reduce((s, p) => s + p.elapsedSec, 0),
  }
}

/** Natural sort so DJI_0002 comes before DJI_0010 and GX010123 before GX020123. */
export function naturalSort(paths: string[]): string[] {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return [...paths].sort(coll.compare)
}

/** Where a segment lands relative to file boundaries – for display. */
export function boundariesIn(tl: Timeline, s: Segment): number[] {
  return tl.offsets.slice(1).filter((o) => o > s.start && o < s.end)
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
