// Shared data model. Everything here is plain JSON so it can cross IPC and be cached on disk.

export interface Point {
  x: number
  y: number
}

export interface SourceInfo {
  path: string
  durationSec: number
  width: number
  height: number
  fps: number
  videoCodec: string
  pixFmt: string
  hasAudio: boolean
  audioSampleRate: number
  sizeBytes: number
  /** Rotation from display matrix (degrees), applied by players/encoders automatically. */
  rotation: number
}

/**
 * The court the user cares about, as four image points in normalized [0..1] coordinates of the source frame.
 * Order: near-baseline left, near-baseline right, then (far side) right, left – i.e. going around the court.
 *  - mode 'full': the far points are the far baseline corners.
 *  - mode 'half': the far points are where the net meets the doubles sidelines (use when the far baseline is
 *    hard to see, e.g. low camera behind one end).
 */
export interface CourtCalibration {
  mode: 'full' | 'half'
  corners: [Point, Point, Point, Point]
}

/** Per-frame visual features, sampled at `fps` over the whole source. */
export interface VideoFeatures {
  fps: number
  /** Width/height of the analysis frame (after scale+crop) in pixels. */
  width: number
  height: number
  /** Analysed crop of the source frame, normalized [0..1]. Analysis pixel (x,y) ↔ source (cropX + x/width*cropW, …). */
  cropX: number
  cropY: number
  cropW: number
  cropH: number
  /** Width of the full source frame expressed in analysis pixels (speed thresholds are relative to this). */
  refWidth: number
  frameCount: number
  /** Fraction of ROI pixels with significant frame-to-frame change, per frame. */
  motion: number[]
  /** Ball-like candidates (moving, ball-colored, small blobs), flattened: frame, x, y, area. */
  candidates: number[]
}

export interface AudioFeatures {
  /** Hop between onset-envelope samples, in seconds. */
  hop: number
  /** Normalized onset strength (≈ z-score above local median), one per hop. Quantized to 0.1 to stay compact. */
  onset: number[]
  /** Detected impact-like transients: time (s) and strength. */
  hits: { t: number; s: number }[]
}

export interface BallTrack {
  /** Frame indices covered by this track (start..end inclusive). */
  start: number
  end: number
  /** Mean speed in analysis pixels/frame. */
  speed: number
  /** Number of horizontal direction reversals (≈ hits/bounces seen from the side). */
  reversals: number
  points: [number, number, number][] // frame, x, y
}

export interface AnalysisResult {
  version: number
  source: SourceInfo
  court: CourtCalibration | null
  video: VideoFeatures
  audio: AudioFeatures | null
  tracks: BallTrack[]
  analyzedAt: string
  elapsedSec: number
}

export interface Segment {
  id: string
  start: number
  end: number
  /** 0..1 detection confidence; manual segments get 1. */
  score: number
  kept: boolean
  manual?: boolean
}

export interface SegmentParams {
  /** 0..1 – higher keeps more (lower thresholds). */
  sensitivity: number
  padBefore: number
  padAfter: number
  /** Merge segments separated by less than this many seconds. */
  mergeGap: number
  minDuration: number
}

export const DEFAULT_SEGMENT_PARAMS: SegmentParams = {
  sensitivity: 0.5,
  padBefore: 1.5,
  padAfter: 1.5,
  mergeGap: 2.5,
  minDuration: 3,
}

export type OutputResolution = 'source' | '720p' | '1080p' | '1440p' | '2160p'
export type OutputContainer = 'mp4' | 'mov' | 'mkv'
export type OutputCodec = 'h264' | 'hevc' | 'copy'

export interface ExportOptions {
  outputPath: string
  resolution: OutputResolution
  container: OutputContainer
  codec: OutputCodec
  /** Quality 0..100 (maps to VideoToolbox -q:v / x264 crf). */
  quality: number
  /** Use hardware encoder when available. */
  hardware: boolean
  /** Add a short audio/video crossfade between rallies. */
  fadeMs: number
}

export interface Progress {
  phase: string
  /** 0..1 */
  fraction: number
  message?: string
  etaSec?: number
}
