/**
 * Links per-frame ball candidates into trajectories and keeps the ones that move like a ball
 * (fast, smooth, coherent) rather than like clothing, shoes or flicker.
 */
import { CAND_STRIDE, type BallTrack, type VideoFeatures } from './types.ts'

interface Live {
  pts: [number, number, number][]
  clutter: number[]
  vx: number
  vy: number
}

export interface TrackerOptions {
  /** Max frames a track may coast without a detection. */
  maxGap: number
  minPoints: number
}

export interface LinkedTrack {
  pts: [number, number, number][]
  /** Per-point clutter (share of moving pixels around the candidate). */
  clutter: number[]
}

/** Link candidates frame-to-frame into raw tracks (no ball/not-ball decision yet). */
export function linkCandidates(v: VideoFeatures, opts: TrackerOptions = { maxGap: 2, minPoints: 4 }): LinkedTrack[] {
  // Speeds are expressed relative to the full-frame width at analysis scale so thresholds don't depend
  // on the chosen analysis resolution or crop.
  const refW = v.refWidth
  const perSec = refW / v.fps
  const maxStep = 0.11 * perSec * 15 // generous: ~fastest serve across the frame
  const minSpeed = 0.13 * perSec // px/frame; walking players stay below this

  // Group candidates by frame.
  const byFrame = new Map<number, [number, number, number, number][]>()
  const c = v.candidates
  for (let i = 0; i < c.length; i += CAND_STRIDE) {
    const f = c[i]
    let arr = byFrame.get(f)
    if (!arr) byFrame.set(f, (arr = []))
    arr.push([c[i + 1], c[i + 2], c[i + 3], c[i + 4]])
  }

  const done: Live[] = []
  let live: Live[] = []
  const frames = [...byFrame.keys()].sort((a, b) => a - b)
  for (const f of frames) {
    const dets = byFrame.get(f)!
    const used = new Uint8Array(dets.length)
    // Retire tracks that have coasted too long.
    const keep: Live[] = []
    for (const t of live) (f - t.pts[t.pts.length - 1][0] > opts.maxGap + 1 ? done : keep).push(t)
    live = keep
    // Greedy nearest assignment, longest tracks first (they have the best velocity estimates).
    live.sort((a, b) => b.pts.length - a.pts.length)
    for (const t of live) {
      const last = t.pts[t.pts.length - 1]
      const dt = f - last[0]
      const px = last[1] + t.vx * dt
      const py = last[2] + t.vy * dt
      const speed = Math.hypot(t.vx, t.vy)
      const gate = t.pts.length >= 2 ? 6 + 0.5 * speed * dt + 0.02 * refW : maxStep * dt
      let best = -1
      let bestD = gate
      for (let k = 0; k < dets.length; k++) {
        if (used[k]) continue
        const d = Math.hypot(dets[k][0] - px, dets[k][1] - py)
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
      if (best >= 0) {
        used[best] = 1
        const [x, y] = dets[best]
        const nvx = (x - last[1]) / dt
        const nvy = (y - last[2]) / dt
        // Smooth velocity but let it react quickly to bounces/hits.
        const a = t.pts.length >= 2 ? 0.6 : 1
        t.vx = a * nvx + (1 - a) * t.vx
        t.vy = a * nvy + (1 - a) * t.vy
        t.pts.push([f, x, y])
        t.clutter.push(dets[best][3])
      }
    }
    for (let k = 0; k < dets.length; k++) {
      if (!used[k]) live.push({ pts: [[f, dets[k][0], dets[k][1]]], clutter: [dets[k][3]], vx: 0, vy: 0 })
    }
  }
  done.push(...live)
  return done.filter((t) => t.pts.length >= opts.minPoints).map((t) => ({ pts: t.pts, clutter: t.clutter }))
}

export interface TrackStats {
  n: number
  /** Median step speed, px/frame. */
  speed: number
  /** Net displacement / path length: ~1 for a flight, ~0 for jitter. */
  straightness: number
  /** Median clutter of the track's candidates. */
  clutter: number
  reversals: number
}

export function trackStats(t: LinkedTrack, minSpeed: number): TrackStats {
  const steps: number[] = []
  let reversals = 0
  let lastSign = 0
  let pathLen = 0
  const p = t.pts
  for (let i = 1; i < p.length; i++) {
    const dt = p[i][0] - p[i - 1][0]
    const dx = p[i][1] - p[i - 1][1]
    const dy = p[i][2] - p[i - 1][2]
    const s = Math.hypot(dx, dy)
    pathLen += s
    steps.push(s / dt)
    const sign = Math.abs(dx) > 0.3 * minSpeed * dt ? Math.sign(dx) : 0
    if (sign !== 0) {
      if (lastSign !== 0 && sign !== lastSign) reversals++
      lastSign = sign
    }
  }
  const first = p[0]
  const last = p[p.length - 1]
  const net = Math.hypot(last[1] - first[1], last[2] - first[2])
  return { n: p.length, speed: median(steps), straightness: pathLen > 0 ? net / pathLen : 0, clutter: median(t.clutter), reversals }
}

export function trackBalls(v: VideoFeatures, opts: TrackerOptions = { maxGap: 2, minPoints: 4 }): BallTrack[] {
  const perFrame = v.refWidth / v.fps // px/frame for "one frame-width per second"
  const fastSpeed = 0.13 * perFrame // clearly faster than anyone walks
  const slowSpeed = 0.035 * perFrame // shots towards/away from the camera barely move across the image
  const out: BallTrack[] = []
  for (const t of linkCandidates(v, opts)) {
    const st = trackStats(t, fastSpeed)
    // Fast tracks: ball flights crossing the image. Mostly-jitter tracks (low straightness) are rejected unless long.
    const fast = st.speed >= fastSpeed && (st.straightness >= 0.25 || st.n >= 10)
    // Slow tracks are only trusted when the candidates are isolated (not on a moving player) and the track
    // actually travels somewhere.
    const slow = !fast && st.speed >= slowSpeed && st.n >= 6 && st.clutter <= SLOW_MAX_CLUTTER && st.straightness >= 0.45
    if (!fast && !slow) continue
    const first = t.pts[0]
    const last = t.pts[t.pts.length - 1]
    out.push({ start: first[0], end: last[0], speed: Math.round(st.speed * 10) / 10, reversals: st.reversals, clutter: st.clutter, points: t.pts })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

export const SLOW_MAX_CLUTTER = 0.12

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
