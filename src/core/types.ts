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
  /**
   * Ball-like candidates (moving, ball-coloured, small blobs), flattened as CAND_STRIDE values each:
   * frame, x, y, area, clutter (share of moving pixels around the blob, 0..1).
   */
  candidates: number[]
}

export const CAND_STRIDE = 5

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
  /** Median share of moving pixels around the track's candidates (0 = isolated ball, high = on a player). */
  clutter?: number
  points: [number, number, number][] // frame, x, y
}

/** Raw player keypoints from the pose model (see players.ts for layout), compactly encoded. */
export interface PlayerPoses {
  /** Pose sampled every `every` analysis frames. */
  every: number
  /** Base64 of Int16Array records: frameHi, frameLo, trackId, then 17×(x·2, y·2, score·1000) in analysis pixels. */
  data: string
  count: number
}

export interface Swing {
  t: number
  /** Which half of the court the hitter is on. */
  side: 'near' | 'far'
  /** Arm above the head: serve or smash. */
  overhead: boolean
  /** Peak wrist speed in torso-lengths per second. */
  speed: number
}

export interface PoseEvents {
  swings: Swing[]
  /** Times (s) when a player on court is bent over (typically picking up balls). */
  pickups: number[]
  /** Fraction of pose samples with at least one player detected on court. */
  coverage: number
}

export interface AnalysisResult {
  version: number
  source: SourceInfo
  court: CourtCalibration | null
  video: VideoFeatures
  audio: AudioFeatures | null
  tracks: BallTrack[]
  players?: PlayerPoses
  poseEvents?: PoseEvents
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
  /** 'serve' = a serve (often a fault) with no rally after it. */
  kind?: 'rally' | 'serve'
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
  // Extra time on top of the built-in lead-in (serve toss / backswing) and the last ball's flight.
  padBefore: 0.5,
  padAfter: 1,
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
  /** Colour LUT from the user's library (applied to preview, analysis and export). */
  lutId?: string | null
  /** Absolute path of the LUT file, resolved by the main process for the exporter. */
  lutFile?: string
}

export interface Progress {
  phase: string
  /** 0..1 */
  fraction: number
  message?: string
  etaSec?: number
}
