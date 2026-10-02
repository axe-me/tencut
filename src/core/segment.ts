/**
 * Turns analysis features into rally segments. Pure and fast (milliseconds for an hour of footage) so the UI
 * can re-run it live while the user drags the sensitivity slider.
 *
 * Evidence, on a 10 Hz grid:
 *  - ball: time covered by ball-like trajectories inside the court ROI (primary signal)
 *  - hits: audio impact transients (secondary; neighbouring courts are audible too, so audio alone never
 *    creates a rally – it only supports and extends ball evidence)
 * A rally is a stretch where the ball is repeatedly in flight with short gaps (players' strokes, bounces);
 * dead time (ball collection, walking back, towelling) has no fast ball flights.
 */
import type { AnalysisResult, BallTrack, Segment, SegmentParams } from './types.ts'

export const GRID_HZ = 10

export interface Evidence {
  ball: Float32Array
  hits: Float32Array
  activity: Float32Array
}

export function trackWeight(t: BallTrack, refWidth: number, fps: number): number {
  const n = t.points.length
  const first = t.points[0]
  const last = t.points[n - 1]
  const dx = Math.abs(last[1] - first[1])
  const dy = Math.abs(last[2] - first[2])
  let pathX = 0
  for (let i = 1; i < n; i++) pathX += Math.abs(t.points[i][1] - t.points[i - 1][1])
  let w = Math.min(1, n / 8)
  // Speed relative to frame width per second. Shots travelling towards/away from the camera look slow in the
  // image, so this only gently discounts tracks near the tracker's minimum speed.
  const speed = (t.speed * fps) / refWidth
  w *= Math.min(1, Math.max(0.35, (speed - 0.1) / 0.12))
  // Mostly-vertical tracks with little sideways travel: a ball bounced in place before serving, or dropped.
  if (pathX < 0.03 * refWidth && dy > 2 * dx) w *= 0.25
  return w
}

export function computeEvidence(a: AnalysisResult): Evidence {
  const n = Math.ceil(a.source.durationSec * GRID_HZ) + 1
  const ball = new Float32Array(n)
  const fps = a.video.fps
  for (const t of a.tracks) {
    const w = trackWeight(t, a.video.refWidth, fps)
    const i0 = Math.floor((t.start / fps) * GRID_HZ)
    const i1 = Math.min(n - 1, Math.ceil((t.end / fps) * GRID_HZ))
    for (let i = i0; i <= i1; i++) ball[i] = Math.max(ball[i], w)
  }
  const hits = new Float32Array(n)
  if (a.audio) {
    for (const h of a.audio.hits) {
      const i = Math.round(h.t * GRID_HZ)
      if (i < n) hits[i] = Math.max(hits[i], Math.min(1, h.s / 25))
    }
  }
  // Activity: share of the surrounding ~2.4 s with ball in flight, plus a little audio support.
  const ballS = boxMean(ball, Math.round(2.4 * GRID_HZ))
  const hitsS = boxSum(hits, Math.round(3 * GRID_HZ))
  const activity = new Float32Array(n)
  for (let i = 0; i < n; i++) activity[i] = Math.min(1, ballS[i] + 0.08 * Math.min(3, hitsS[i]) * (ballS[i] > 0.05 ? 1 : 0.3))
  return { ball, hits, activity }
}

export function segmentRallies(a: AnalysisResult, p: SegmentParams, ev = computeEvidence(a)): Segment[] {
  const { activity, ball, hits } = ev
  const n = activity.length
  const s = Math.min(1, Math.max(0, p.sensitivity))
  const hi = 0.5 - 0.3 * s // 0.5 (strict) … 0.2 (loose)
  const lo = hi * 0.45

  // Hysteresis.
  const raw: [number, number][] = []
  let i = 0
  while (i < n) {
    if (activity[i] < hi) {
      i++
      continue
    }
    let a0 = i
    while (a0 > 0 && activity[a0 - 1] >= lo) a0--
    let a1 = i
    while (a1 < n - 1 && activity[a1 + 1] >= lo) a1++
    raw.push([a0, a1])
    i = a1 + 1
  }

  // Tighten to actual ball evidence: activity is smoothed, so edges overshoot by ~1 s.
  const tight: [number, number][] = []
  for (const [a0, a1] of raw) {
    let b0 = a0
    while (b0 < a1 && ball[b0] < 0.15) b0++
    let b1 = a1
    while (b1 > b0 && ball[b1] < 0.15) b1--
    if (b1 > b0) tight.push([b0, b1])
  }

  // Merge short gaps (lost track mid-rally, a long lob out of view).
  const gap = p.mergeGap * GRID_HZ
  const merged: [number, number][] = []
  for (const r of tight) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] <= gap) last[1] = r[1]
    else merged.push([...r])
  }

  const out: Segment[] = []
  const dur = a.source.durationSec
  for (const [a0, a1] of merged) {
    let ballTime = 0
    let hitCount = 0
    let act = 0
    for (let k = a0; k <= a1; k++) {
      ballTime += ball[k] / GRID_HZ
      if (hits[k] > 0) hitCount++
      act += activity[k]
    }
    const len = (a1 - a0) / GRID_HZ
    // A real point needs the ball in flight for a while: at least a serve + return.
    const minBall = 0.8 + 1.0 * (1 - s)
    if (ballTime < minBall) continue
    if (len < p.minDuration * 0.5) continue
    const score = Math.min(1, (act / (a1 - a0 + 1)) * 1.3 + Math.min(0.25, hitCount * 0.03))
    const start = Math.max(0, a0 / GRID_HZ - p.padBefore)
    const end = Math.min(dur, a1 / GRID_HZ + p.padAfter)
    if (end - start < p.minDuration) continue
    out.push({ id: `r${Math.round(start * 10)}`, start: round2(start), end: round2(end), score: round2(score), kept: true })
  }
  // Padding can make neighbours overlap; join them.
  const final: Segment[] = []
  for (const sgm of out) {
    const last = final[final.length - 1]
    if (last && sgm.start <= last.end) {
      last.end = sgm.end
      last.score = Math.max(last.score, sgm.score)
    } else final.push(sgm)
  }
  return final
}

/** Count likely strokes in a time range (direction reversals in ball tracks + audio hits, de-duplicated). */
export function estimateShots(a: AnalysisResult, start: number, end: number): number {
  const fps = a.video.fps
  const times: number[] = []
  for (const t of a.tracks) {
    if (t.end / fps < start || t.start / fps > end) continue
    times.push(t.start / fps)
  }
  if (a.audio) for (const h of a.audio.hits) if (h.t >= start && h.t <= end && h.s >= 12) times.push(h.t)
  times.sort((x, y) => x - y)
  let n = 0
  let last = -Infinity
  for (const t of times) {
    if (t - last > 0.6) n++
    last = t
  }
  return n
}

function boxMean(x: Float32Array, win: number): Float32Array {
  const s = boxSum(x, win)
  for (let i = 0; i < s.length; i++) s[i] /= win
  return s
}

function boxSum(x: Float32Array, win: number): Float32Array {
  const n = x.length
  const out = new Float32Array(n)
  const half = Math.floor(win / 2)
  let acc = 0
  for (let i = 0; i < Math.min(n, half); i++) acc += x[i]
  for (let i = 0; i < n; i++) {
    const add = i + half
    const rem = i - half - 1
    if (add < n) acc += x[add]
    if (rem >= 0) acc -= x[rem]
    out[i] = acc
  }
  return out
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export function totalDuration(segs: Segment[]): number {
  return segs.filter((s) => s.kept).reduce((t, s) => t + (s.end - s.start), 0)
}
