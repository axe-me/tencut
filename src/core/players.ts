/**
 * Follows the players on the marked court through a chunk of frames and records their keypoints.
 *
 * Detect-then-track (as in RTMPose's real-time pipeline): the person detector runs about once a second; in
 * between, each player's box is taken from their previous skeleton and only the cheap pose model runs.
 * Only people whose feet are on the marked court (plus run-off) are kept – players on neighbouring courts,
 * spectators and coaches by the fence are ignored.
 */
import { boxFromKeypoints, iou, meanScore, type Box, type Keypoints, type PoseRunner } from './pose.ts'
import type { Point } from './types.ts'

export interface PlayerTrackerOptions {
  /** Ground polygon (court + run-off) in frame pixels. Empty = accept everyone. */
  ground: Point[]
  /** Run the detector every N pose frames (and whenever nobody is being followed). */
  detectEvery: number
  maxPlayers: number
}

/** One person in one frame: frame index, local track id, 17×(x, y, score). */
export const POSE_STRIDE = 2 + 51

interface Followed {
  id: number
  box: Box
}

export class PlayerTracker {
  private runner: PoseRunner
  private o: PlayerTrackerOptions
  private followed: Followed[] = []
  private nextId = 0
  private n = 0

  constructor(runner: PoseRunner, o: PlayerTrackerOptions) {
    this.runner = runner
    this.o = o
  }

  /** Process one frame; appends POSE_STRIDE values per visible player to `out`. */
  async process(frame: number, rgb: Uint8Array, w: number, h: number, out: number[]): Promise<void> {
    if (this.n % this.o.detectEvery === 0 || this.followed.length === 0) {
      const dets = (await this.runner.detect(rgb, w, h)).filter((b) => this.onCourt(b))
      dets.sort((a, b) => b.score - a.score)
      const next: Followed[] = []
      for (const d of dedupe(dets).slice(0, this.o.maxPlayers)) {
        let best: Followed | null = null
        let bestIou = 0.2
        for (const f of this.followed) {
          const v = iou(f.box, d)
          if (v > bestIou && !next.includes(f)) (best = f), (bestIou = v)
        }
        next.push({ id: best ? best.id : this.nextId++, box: d })
      }
      this.followed = next
    }
    this.n++
    const keep: Followed[] = []
    for (const f of this.followed) {
      const k = await this.runner.estimate(rgb, w, h, f.box)
      const nb = boxFromKeypoints(k)
      if (!nb || meanScore(k) < 0.25 || !this.onCourt(nb)) continue
      f.box = nb
      keep.push(f)
      out.push(frame, f.id)
      for (let i = 0; i < 51; i++) out.push(Math.round(k[i] * (i % 3 === 2 ? 100 : 2)) / (i % 3 === 2 ? 100 : 2))
    }
    this.followed = keep
  }

  private onCourt(b: Box): boolean {
    const g = this.o.ground
    if (g.length < 3) return true
    return pointInPolygon({ x: (b.x0 + b.x1) / 2, y: b.y1 }, g)
  }
}

function dedupe(boxes: Box[]): Box[] {
  const out: Box[] = []
  for (const b of boxes) if (!out.some((o) => iou(o, b) > 0.5)) out.push(b)
  return out
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export type { Keypoints }
