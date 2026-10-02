/**
 * Turns analysis features into rally segments. Pure and fast (milliseconds for an hour of footage) so the UI
 * can re-run it live while the user drags the sensitivity slider.
 *
 * Evidence, on a 10 Hz grid:
 *  - ball: time covered by ball-like trajectories inside the court ROI (primary signal)
 *  - hits: audio impact transients (secondary; neighbouring courts are audible too, so audio alone never
 *    creates a rally – it only supports and extends ball evidence)
 *  - players (pose model, when available): swings that alternate between the two ends of the court are a
 *    rally even when the ball itself isn't visible; players bent over picking up balls mark dead time
 * A rally is a stretch where the ball is repeatedly in flight with short gaps (players' strokes, bounces);
 * dead time (ball collection, walking back, towelling) has no fast ball flights and no exchanges.
 */
import type { AnalysisResult, BallTrack, Segment, SegmentParams } from './types.ts'

export const GRID_HZ = 10

export interface Evidence {
  /** Ball in play: tracked flights, plus spans between alternating swings. */
  ball: Float32Array
  hits: Float32Array
  /** 1 where a player swings (for display). */
  swings: Float32Array
  activity: Float32Array
}

/** Swings on opposite ends this far apart (s) are an exchange – the ball travelled between the players. */
const EXCHANGE_GAP: [number, number] = [0.6, 3.5]
/** Ball-in-play weight for the span of an exchange. */
const EXCHANGE_WEIGHT = 0.8

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
  const swings = new Float32Array(n)
  const exchange = new Uint8Array(n)
  const pe = a.poseEvents
  if (pe) {
    const sw = pe.swings
    for (const x of sw) {
      const i = Math.round(x.t * GRID_HZ)
      if (i < n) swings[i] = 1
    }
    for (let i = 0; i + 1 < sw.length; i++) {
      const gap = sw[i + 1].t - sw[i].t
      if (sw[i + 1].side === sw[i].side || gap < EXCHANGE_GAP[0] || gap > EXCHANGE_GAP[1]) continue
      // The ball is in play from this stroke until shortly after the reply (it has to fly somewhere).
      const i0 = Math.max(0, Math.floor(sw[i].t * GRID_HZ))
      const i1 = Math.min(n - 1, Math.ceil((sw[i + 1].t + 1) * GRID_HZ))
      for (let k = i0; k <= i1; k++) {
        ball[k] = Math.max(ball[k], EXCHANGE_WEIGHT)
        exchange[k] = 1
      }
    }
  }
  // Activity: share of the surrounding ~2.4 s with ball in flight, plus a little audio support.
  const ballS = boxMean(ball, Math.round(2.4 * GRID_HZ))
  const hitsS = boxSum(hits, Math.round(3 * GRID_HZ))
  const activity = new Float32Array(n)
  for (let i = 0; i < n; i++) activity[i] = Math.min(1, ballS[i] + 0.08 * Math.min(3, hitsS[i]) * (ballS[i] > 0.05 ? 1 : 0.3))
  // Someone bent over picking up balls, with no exchange going on: dead time.
  if (pe) {
    for (const t of pe.pickups) {
      const c = Math.round(t * GRID_HZ)
      for (let k = Math.max(0, c - GRID_HZ); k <= Math.min(n - 1, c + GRID_HZ); k++) {
        if (exchange[k]) continue
        activity[k] *= 0.3
        ball[k] *= 0.3
      }
    }
  }
  return { ball, hits, swings, activity }
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

  // Candidate ranges in seconds (ball-evidence bounds, before padding).
  interface Range {
    s: number
    e: number
    score: number
    serveOnly: boolean
  }
  const ranges: Range[] = []
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
    ranges.push({ s: a0 / GRID_HZ, e: a1 / GRID_HZ, score, serveOnly: false })
  }

  // Serves – including faults that never start a rally – are kept as their own short clips.
  for (const sv of detectServes(a)) {
    if (ranges.some((r) => sv.hit >= r.s - 0.5 && sv.hit <= r.e + 0.5)) continue
    ranges.push({ s: sv.toss - 1, e: sv.hit + SERVE_FLIGHT, score: 0.6, serveOnly: true })
  }

  // Loud racket hits right at a clip's edges mean the ball tracker lost the ball (blurred serve or smash, final
  // shot out of view); stretch the clip to cover them. Hits must chain within a rally-like rhythm.
  const loud = (a.audio?.hits ?? []).filter((h) => h.s >= EDGE_HIT_MIN)
  for (const r of ranges) {
    const e0 = r.e
    for (let changed = true; changed && r.e - e0 < 6; ) {
      changed = false
      for (const h of loud) {
        if (h.t > r.e - 0.3 && h.t <= r.e + 2.5 && h.t + 1 > r.e) {
          r.e = h.t + 1
          changed = true
        }
      }
    }
    const before = loud.filter((h) => h.s >= SERVE_HIT_MIN && h.t < r.s && h.t >= r.s - 2.5)
    if (before.length) r.s = Math.min(r.s, before[0].t - 1.2)
  }

  const out: Segment[] = []
  const dur = a.source.durationSec
  for (const r of ranges) {
    const start = Math.max(0, r.s - p.padBefore)
    const end = Math.min(dur, r.e + p.padAfter)
    if (!r.serveOnly && end - start < p.minDuration) continue
    out.push({ id: `r${Math.round(start * 10)}`, start: round2(start), end: round2(end), score: round2(r.score), kept: true, kind: r.serveOnly ? 'serve' : 'rally' })
  }
  out.sort((x, y) => x.start - y.start)
  // Padding can make neighbours overlap; join them.
  const final: Segment[] = []
  for (const sgm of out) {
    const last = final[final.length - 1]
    if (last && sgm.start <= last.end) {
      last.end = Math.max(last.end, sgm.end)
      last.score = Math.max(last.score, sgm.score)
      if (sgm.kind === 'rally') last.kind = 'rally'
    } else final.push(sgm)
  }
  return final
}

/** Loud hits at a clip's edge extend it (racket impacts are well above this; footsteps/voices below). */
const EDGE_HIT_MIN = 15
/** Serve impacts are among the loudest sounds on court. */
const SERVE_HIT_MIN = 18
/** Time from serve impact until a fault has landed / the return is under way. */
const SERVE_FLIGHT = 2

export interface ServeEvent {
  /** Toss apex time (s). */
  toss: number
  /** Racket impact time (s). */
  hit: number
}

/**
 * Serve = a ball toss (a near-vertical rise well above the hand) followed within ~2 s by a loud racket hit.
 * The served ball itself is often a faint motion-blurred streak the tracker misses, but the toss is slow
 * and clearly visible, and the impact is one of the loudest sounds on court.
 */
export function detectServes(a: AnalysisResult): ServeEvent[] {
  if (!a.audio) return []
  const fromPose: ServeEvent[] = []
  // Pose: an overhead swing with a racket impact at the same moment. (Smashes also qualify, but those happen
  // inside rallies, where serve clips are never added.)
  for (const sw of a.poseEvents?.swings ?? []) {
    if (!sw.overhead) continue
    const h = a.audio.hits.find((h) => h.s >= 12 && Math.abs(h.t - sw.t) <= 0.4)
    if (h) fromPose.push({ toss: h.t - 1, hit: h.t })
  }
  const fromToss = detectTossServes(a)
  const all = [...fromPose]
  for (const s of fromToss) if (!all.some((p) => Math.abs(p.hit - s.hit) < 1)) all.push(s)
  return all.sort((x, y) => x.hit - y.hit)
}

function detectTossServes(a: AnalysisResult): ServeEvent[] {
  if (!a.audio) return []
  const fps = a.video.fps
  const minRise = 0.035 * a.video.refWidth
  const loud = a.audio.hits.filter((h) => h.s >= SERVE_HIT_MIN)
  const out: ServeEvent[] = []
  for (const t of a.tracks) {
    const p = t.points
    // Largest upward travel (image y decreases) reaching its apex within 1.2 s.
    let best = 0
    let apex = -1
    let from = -1
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length && p[j][0] - p[i][0] <= 1.2 * fps; j++) {
        const rise = p[i][2] - p[j][2]
        if (rise > best) {
          best = rise
          apex = j
          from = i
        }
      }
    }
    if (apex < 0 || best < minRise) continue
    let x0 = Infinity
    let x1 = -Infinity
    for (let k = from; k <= apex; k++) {
      x0 = Math.min(x0, p[k][1])
      x1 = Math.max(x1, p[k][1])
    }
    if (x1 - x0 > 0.5 * best || apex - from < 3) continue // tosses go straight up
    const ta = p[apex][0] / fps
    const h = loud.find((h) => h.t >= ta - 0.2 && h.t <= ta + 2)
    if (!h) continue
    if (out.length && Math.abs(out[out.length - 1].hit - h.t) < 0.5) continue
    out.push({ toss: ta, hit: h.t })
  }
  return out.sort((x, y) => x.hit - y.hit)
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
