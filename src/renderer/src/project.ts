import { segmentRallies, computeEvidence, type Evidence } from '../../core/segment'
import { DEFAULT_SEGMENT_PARAMS, type AnalysisResult, type CourtCalibration, type ExportOptions, type Segment, type SegmentParams, type SourceInfo } from '../../core/types'

export type OutputSettings = Omit<ExportOptions, 'outputPath'>

export const DEFAULT_OUTPUT: OutputSettings = {
  resolution: '1080p',
  container: 'mp4',
  codec: 'h264',
  quality: 60,
  hardware: true,
  fadeMs: 0,
}

/** What gets persisted per source file. */
export interface ProjectState {
  version: 1
  /** Recordings of the match in playback order (one file, or a camera's split parts). */
  sourcePaths: string[]
  /** @deprecated single-file projects saved before multi-file support. */
  sourcePath?: string
  court: CourtCalibration | null
  output: OutputSettings
  params: SegmentParams
  /** Run the player pose model during analysis (more accurate, about half the speed). */
  usePose?: boolean
  /** Segments the user created or edited. They override any overlapping automatic detection. */
  manual: Segment[]
}

export function newProject(sources: SourceInfo[]): ProjectState {
  const source = sources[0]
  const short = Math.min(source.width, source.height)
  return {
    version: 1,
    sourcePaths: sources.map((s) => s.path),
    court: null,
    output: { ...DEFAULT_OUTPUT, resolution: short > 1080 ? '1080p' : 'source' },
    params: { ...DEFAULT_SEGMENT_PARAMS },
    usePose: true,
    manual: [],
  }
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

export function buildSegments(analysis: AnalysisResult, params: SegmentParams, manual: Segment[], ev?: Evidence): Segment[] {
  const auto = segmentRallies(analysis, params, ev ?? computeEvidence(analysis))
  const keepAuto = auto.filter((a) => !manual.some((m) => overlaps(a, m)))
  return [...manual, ...keepAuto].sort((a, b) => a.start - b.start)
}

let idSeq = 0
export function newId(): string {
  return `m${Date.now().toString(36)}${(idSeq++).toString(36)}`
}

/** Apply an edit to a (possibly automatic) segment: it becomes manual so it survives re-detection. */
export function upsertManual(manual: Segment[], seg: Segment): Segment[] {
  const s = { ...seg, manual: true }
  const others = manual.filter((m) => m.id !== seg.id)
  return [...others, s].sort((a, b) => a.start - b.start)
}

/**
 * Clip edges now snap to the first/last shot with a built-in lead-in, so the padding defaults went from 1.5/1.5 s
 * to 0.5/1 s of *extra* time. Projects still on the old defaults move to the new ones; customised values stay.
 */
export function migrateProject(p: ProjectState): ProjectState {
  if (p.params.padBefore === 1.5 && p.params.padAfter === 1.5) {
    return { ...p, params: { ...p.params, padBefore: DEFAULT_SEGMENT_PARAMS.padBefore, padAfter: DEFAULT_SEGMENT_PARAMS.padAfter } }
  }
  return p
}
