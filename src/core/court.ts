import type { CourtCalibration, Point } from './types.ts'

// Doubles court in metres. x across the court (sideline to sideline), y along it (baseline A → baseline B).
export const COURT_W = 10.97
export const COURT_L = 23.77

export type Mat3 = [number, number, number, number, number, number, number, number, number]

/** Solve A·x = b (n×n) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Degenerate court corners')
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

/** Homography mapping src[i] → dst[i] for four point pairs. */
export function homography(src: Point[], dst: Point[]): Mat3 {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solve(A, b)
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

export function apply(H: Mat3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8]
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w }
}

/** Court-metres → image pixels for a frame of the given size. */
export function courtToImage(cal: CourtCalibration, width: number, height: number): Mat3 {
  const img = cal.corners.map((c) => ({ x: c.x * width, y: c.y * height }))
  const far = cal.mode === 'half' ? COURT_L / 2 : COURT_L
  const court: Point[] = [
    { x: 0, y: 0 },
    { x: COURT_W, y: 0 },
    { x: COURT_W, y: far },
    { x: 0, y: far },
  ]
  return homography(court, img)
}

/**
 * Region of interest in image pixels: the court floor plus run-off, extruded upwards so it also covers
 * players' bodies and balls in flight. Returned as a convex polygon.
 */
export function roiPolygon(
  cal: CourtCalibration,
  width: number,
  height: number,
  opts = { sideMargin: 2.5, endMargin: 5, heightM: 3 },
): Point[] {
  const H = courtToImage(cal, width, height)
  const { sideMargin: sm, endMargin: em, heightM } = opts
  const ground: Point[] = []
  // Sample the expanded rectangle densely so perspective is respected.
  const xs = [-sm, COURT_W / 2, COURT_W + sm]
  const ys = [-em, COURT_L / 4, COURT_L / 2, (3 * COURT_L) / 4, COURT_L + em]
  for (const x of xs) for (const y of ys) ground.push({ x, y })
  const pts: Point[] = []
  for (const g of ground) {
    const p = apply(H, g)
    pts.push(p)
    // Local pixels-per-metre at this ground point, used to approximate vertical extrusion.
    const q = apply(H, { x: g.x + 0.5, y: g.y })
    const r = apply(H, { x: g.x, y: g.y + 0.5 })
    const ppm = (Math.hypot(q.x - p.x, q.y - p.y) + Math.hypot(r.x - p.x, r.y - p.y)) / 2 / 0.5
    pts.push({ x: p.x, y: p.y - heightM * ppm })
  }
  return convexHull(pts).map((p) => ({
    x: Math.min(width, Math.max(0, p.x)),
    y: Math.min(height, Math.max(0, p.y)),
  }))
}

export function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (pts.length < 3) return pts
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** Rasterize a polygon into a Uint8Array mask (1 = inside). */
export function polygonMask(poly: Point[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  if (poly.length < 3) return mask.fill(1)
  for (let y = 0; y < height; y++) {
    const yc = y + 0.5
    const xs: number[] = []
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]
      const b = poly[j]
      if (a.y > yc !== b.y > yc) xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5))
      const x1 = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5))
      if (x1 >= x0) mask.fill(1, y * width + x0, y * width + x1 + 1)
    }
  }
  return mask
}

export function bbox(poly: Point[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const p of poly) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return { x0, y0, x1, y1 }
}
