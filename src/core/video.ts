/**
 * Streaming per-frame visual features. Frames arrive as packed RGB24 of a fixed size; only the last three
 * frames are kept in memory.
 *
 * Features:
 *  - motion: fraction of ROI pixels that changed noticeably since the previous frame
 *  - ball candidates: small blobs that (a) differ from both neighbouring frames (so they moved in and out
 *    of that spot) and (b) have tennis-ball colour (optic yellow-green). Evaluated on the middle frame.
 */

export interface FrameAnalyzerOptions {
  width: number
  height: number
  /** 1 = analyse pixel, 0 = ignore. */
  mask: Uint8Array
  /** Max blob extent (px) for a ball candidate. */
  maxBlob?: number
  maxCandidatesPerFrame?: number
}

const MOTION_T = 36 // on sum of RGB (≈12 per channel)
const BALL_DIFF_T = 45

export class FrameAnalyzer {
  readonly w: number
  readonly h: number
  private mask: Uint8Array
  private maskArea: number
  private gray: Int16Array[] = []
  private rgb: Uint8Array[] = []
  private cand: Uint8Array
  private visited: Uint8Array
  private stack: Int32Array
  private maxBlob: number
  private maxCand: number
  frameIndex = 0

  constructor(o: FrameAnalyzerOptions) {
    this.w = o.width
    this.h = o.height
    this.mask = o.mask
    let a = 0
    for (let i = 0; i < o.mask.length; i++) a += o.mask[i]
    this.maskArea = Math.max(1, a)
    this.cand = new Uint8Array(this.w * this.h)
    this.visited = new Uint8Array(this.w * this.h)
    this.stack = new Int32Array(this.w * this.h)
    this.maxBlob = o.maxBlob ?? 28
    this.maxCand = o.maxCandidatesPerFrame ?? 24
  }

  /**
   * Push the next frame. Returns motion for this frame and ball candidates for the *previous* frame
   * (which needs a successor for the 3-frame test), flattened as [x, y, area, clutter] per candidate.
   */
  push(frame: Uint8Array): { motion: number; candidates: number[] } {
    const n = this.w * this.h
    // Reuse buffers once the ring is full.
    let g: Int16Array
    let rgb: Uint8Array
    if (this.gray.length === 3) {
      g = this.gray.shift()!
      rgb = this.rgb.shift()!
    } else {
      g = new Int16Array(n)
      rgb = new Uint8Array(n * 3)
    }
    rgb.set(frame.subarray(0, n * 3))
    for (let i = 0, j = 0; i < n; i++, j += 3) g[i] = rgb[j] + rgb[j + 1] + rgb[j + 2]
    this.gray.push(g)
    this.rgb.push(rgb)

    let motion = 0
    const L = this.gray.length
    if (L >= 2) {
      const prev = this.gray[L - 2]
      const mask = this.mask
      let c = 0
      for (let i = 0; i < n; i++) {
        if (mask[i] === 0) continue
        const d = g[i] - prev[i]
        if (d > MOTION_T || d < -MOTION_T) c++
      }
      motion = c / this.maskArea
    }
    const candidates = L === 3 ? this.ballCandidates() : []
    this.frameIndex++
    return { motion, candidates }
  }

  private ballCandidates(): number[] {
    const [g0, g1, g2] = this.gray
    const rgb = this.rgb[1]
    const { w, h, mask, cand, visited, stack } = this
    const n = w * h
    const seeds: number[] = []
    for (let i = 0; i < n; i++) {
      if (mask[i] === 0) continue
      const v = g1[i]
      const a = v - g0[i]
      const b = v - g2[i]
      // Must differ from both neighbours in the same direction (object present only in middle frame).
      if (!((a > BALL_DIFF_T && b > BALL_DIFF_T) || (a < -BALL_DIFF_T && b < -BALL_DIFF_T))) continue
      const j = i * 3
      const r = rgb[j]
      const gg = rgb[j + 1]
      const bl = rgb[j + 2]
      if (!isBallColor(r, gg, bl)) continue
      cand[i] = 1
      seeds.push(i)
    }
    const out: number[] = []
    const blobs: [number, number, number, number][] = []
    for (const s of seeds) {
      if (visited[s]) continue
      let sp = 0
      stack[sp++] = s
      visited[s] = 1
      let area = 0,
        sx = 0,
        sy = 0,
        x0 = w,
        x1 = 0,
        y0 = h,
        y1 = 0
      while (sp > 0) {
        const p = stack[--sp]
        const px = p % w
        const py = (p - px) / w
        area++
        sx += px
        sy += py
        if (px < x0) x0 = px
        if (px > x1) x1 = px
        if (py < y0) y0 = py
        if (py > y1) y1 = py
        // 8-connectivity
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy
          if (yy < 0 || yy >= h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx
            if (xx < 0 || xx >= w) continue
            const q = yy * w + xx
            if (cand[q] && !visited[q]) {
              visited[q] = 1
              stack[sp++] = q
            }
          }
        }
      }
      const ext = Math.max(x1 - x0, y1 - y0) + 1
      if (area >= 2 && ext <= this.maxBlob && area <= this.maxBlob * 4) blobs.push([sx / area, sy / area, area, this.clutter(x0, y0, x1, y1)])
    }
    for (const s of seeds) {
      cand[s] = 0
      visited[s] = 0
    }
    // Too many candidates in one frame means a camera bump / lighting flicker; keep the most ball-like.
    if (blobs.length > this.maxCand) blobs.sort((a, b) => Math.abs(a[2] - 10) - Math.abs(b[2] - 10)).length = this.maxCand
    for (const b of blobs) out.push(Math.round(b[0] * 10) / 10, Math.round(b[1] * 10) / 10, b[2], Math.round(b[3] * 100) / 100)
    return out
  }

  /**
   * Share of moving pixels in a ring around a blob (0 = isolated, 1 = surrounded by motion). A ball in flight is
   * a small moving thing in still surroundings; a patch of shirt or shoe sits on a large moving body. This lets
   * the tracker accept slow-looking ball flights (shots travelling towards/away from the camera) without
   * accepting players' clothing.
   */
  private clutter(x0: number, y0: number, x1: number, y1: number): number {
    const [g0, g1, g2] = this.gray
    const { w, h, mask } = this
    const R = 10
    const ax = Math.max(0, x0 - R)
    const bx = Math.min(w - 1, x1 + R)
    const ay = Math.max(0, y0 - R)
    const by = Math.min(h - 1, y1 + R)
    let moving = 0
    let total = 0
    for (let y = ay; y <= by; y++) {
      const inY = y >= y0 - 2 && y <= y1 + 2
      for (let x = ax; x <= bx; x++) {
        if (inY && x >= x0 - 2 && x <= x1 + 2) continue
        const i = y * w + x
        if (mask[i] === 0) continue
        total++
        const v = g1[i]
        const a = v - g0[i]
        const b = v - g2[i]
        if (a > MOTION_T || a < -MOTION_T || b > MOTION_T || b < -MOTION_T) moving++
      }
    }
    return total ? moving / total : 0
  }
}

/** Optic-yellow test in HSV terms: hue ≈ 45–115°, reasonably saturated and bright. Robust to blur onto green/blue. */
export function isBallColor(r: number, g: number, b: number): boolean {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b
  const min = r < g ? (r < b ? r : b) : g < b ? g : b
  if (max < 95) return false
  const d = max - min
  if (d < 0.2 * max) return false
  let hue: number
  if (max === r) hue = 60 * ((g - b) / d)
  else if (max === g) hue = 60 * ((b - r) / d + 2)
  else return false // blue-dominant: court, sky
  if (hue < 0) hue += 360
  return hue >= 45 && hue <= 112
}
