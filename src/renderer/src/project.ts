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
  sourcePath: string
  court: CourtCalibration | null
  output: OutputSettings
  params: SegmentParams
  /** Segments the user created or edited. They override any overlapping automatic detection. */
  manual: Segment[]
}

export function newProject(source: SourceInfo): ProjectState {
  const short = Math.min(source.width, source.height)
  return {
    version: 1,
    sourcePath: source.path,
    court: null,
    output: { ...DEFAULT_OUTPUT, resolution: short > 1080 ? '1080p' : 'source' },
    params: { ...DEFAULT_SEGMENT_PARAMS },
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
