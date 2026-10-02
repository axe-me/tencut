/**
 * Links per-frame ball candidates into trajectories and keeps the ones that move like a ball
 * (fast, smooth, coherent) rather than like clothing, shoes or flicker.
 */
import type { BallTrack, VideoFeatures } from './types.ts'

interface Live {
  pts: [number, number, number][]
  vx: number
  vy: number
}

export interface TrackerOptions {
  /** Max frames a track may coast without a detection. */
  maxGap: number
  minPoints: number
}

export function trackBalls(v: VideoFeatures, opts: TrackerOptions = { maxGap: 2, minPoints: 4 }): BallTrack[] {
  // Speeds are expressed relative to the full-frame width at analysis scale so thresholds don't depend
  // on the chosen analysis resolution or crop.
  const refW = v.refWidth
  const perSec = refW / v.fps
  const maxStep = 0.11 * perSec * 15 // generous: ~fastest serve across the frame
  const minSpeed = 0.13 * perSec // px/frame; walking players stay below this

  // Group candidates by frame.
  const byFrame = new Map<number, [number, number, number][]>()
  const c = v.candidates
  for (let i = 0; i < c.length; i += 4) {
    const f = c[i]
    let arr = byFrame.get(f)
    if (!arr) byFrame.set(f, (arr = []))
    arr.push([c[i + 1], c[i + 2], c[i + 3]])
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
      }
    }
    for (let k = 0; k < dets.length; k++) {
      if (!used[k]) live.push({ pts: [[f, dets[k][0], dets[k][1]]], vx: 0, vy: 0 })
    }
  }
  done.push(...live)

  const out: BallTrack[] = []
  for (const t of done) {
    if (t.pts.length < opts.minPoints) continue
    const steps: number[] = []
    let reversals = 0
    let lastSign = 0
    let pathLen = 0
    for (let i = 1; i < t.pts.length; i++) {
      const dt = t.pts[i][0] - t.pts[i - 1][0]
      const dx = t.pts[i][1] - t.pts[i - 1][1]
      const dy = t.pts[i][2] - t.pts[i - 1][2]
      const s = Math.hypot(dx, dy)
      pathLen += s
      steps.push(s / dt)
      const sign = Math.abs(dx) > 0.3 * minSpeed * dt ? Math.sign(dx) : 0
      if (sign !== 0) {
        if (lastSign !== 0 && sign !== lastSign) reversals++
        lastSign = sign
      }
    }
    steps.sort((a, b) => a - b)
    const med = steps[Math.floor(steps.length / 2)]
    const first = t.pts[0]
    const last = t.pts[t.pts.length - 1]
    const net = Math.hypot(last[1] - first[1], last[2] - first[2])
    // Ball flights are fast and mostly go somewhere; jitter on clothing has low net displacement.
    if (med < minSpeed) continue
    if (net < 0.25 * pathLen && t.pts.length < 10) continue
    out.push({ start: first[0], end: last[0], speed: Math.round(med * 10) / 10, reversals, points: t.pts })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}
