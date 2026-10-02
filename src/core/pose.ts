/**
 * Player pose estimation with ONNX Runtime (Apache-2.0 models from OpenMMLab):
 *  - YOLOX-tiny (HumanArt) person detector, 416×416, NMS inside the graph
 *  - RTMPose-t (Body7) top-down keypoints, 256×192, SimCC heads → 17 COCO keypoints
 *
 * Pre/post-processing is plain TypeScript on RGB24 buffers so it runs in the analysis worker threads
 * without image libraries.
 */
import type * as OrtNs from 'onnxruntime-node'

type Ort = typeof OrtNs

export const DET_SIZE = 416
export const POSE_W = 192
export const POSE_H = 256
const SIMCC_SPLIT = 2

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
}

/** 17 COCO keypoints as [x, y, score] in image pixels. */
export type Keypoints = Float32Array // length 51

export const KP = {
  nose: 0,
  lShoulder: 5,
  rShoulder: 6,
  lElbow: 7,
  rElbow: 8,
  lWrist: 9,
  rWrist: 10,
  lHip: 11,
  rHip: 12,
  lKnee: 13,
  rKnee: 14,
  lAnkle: 15,
  rAnkle: 16,
} as const

export interface PoseModelPaths {
  detector: string
  pose: string
}

export class PoseRunner {
  private ort: Ort
  private det: OrtNs.InferenceSession
  private pose: OrtNs.InferenceSession

  private constructor(ort: Ort, det: OrtNs.InferenceSession, pose: OrtNs.InferenceSession) {
    this.ort = ort
    this.det = det
    this.pose = pose
  }

  static async create(ort: Ort, paths: PoseModelPaths, threads = 1): Promise<PoseRunner> {
    const opts: OrtNs.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    }
    const [det, pose] = await Promise.all([ort.InferenceSession.create(paths.detector, opts), ort.InferenceSession.create(paths.pose, opts)])
    return new PoseRunner(ort, det, pose)
  }

  /** Person boxes in image pixels. `region` limits detection to a sub-rectangle (e.g. the far half, upscaled). */
  async detect(rgb: Uint8Array, w: number, h: number, region = { x: 0, y: 0, w, h }, minScore = 0.3): Promise<Box[]> {
    const s = Math.min(DET_SIZE / region.w, DET_SIZE / region.h)
    const input = new Float32Array(3 * DET_SIZE * DET_SIZE).fill(114)
    const plane = DET_SIZE * DET_SIZE
    const rw = Math.round(region.w * s)
    const rh = Math.round(region.h * s)
    // Bilinear resize into the top-left of a 114-padded square, BGR channel order, 0..255 (mmdet convention).
    for (let y = 0; y < rh; y++) {
      const sy = region.y + (y + 0.5) / s - 0.5
      const y0 = clampInt(Math.floor(sy), 0, h - 1)
      const y1 = clampInt(y0 + 1, 0, h - 1)
      const fy = sy - Math.floor(sy)
      for (let x = 0; x < rw; x++) {
        const sx = region.x + (x + 0.5) / s - 0.5
        const x0 = clampInt(Math.floor(sx), 0, w - 1)
        const x1 = clampInt(x0 + 1, 0, w - 1)
        const fx = sx - Math.floor(sx)
        const o = y * DET_SIZE + x
        for (let c = 0; c < 3; c++) {
          const v = lerp2(rgb, w, x0, x1, y0, y1, fx, fy, c)
          input[(2 - c) * plane + o] = v // RGB → BGR
        }
      }
    }
    const out = await this.det.run({ [this.det.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) })
    const dets = out.dets.data as Float32Array
    const labels = out.labels?.data as BigInt64Array | Int32Array | undefined
    const n = out.dets.dims[1]
    const boxes: Box[] = []
    for (let i = 0; i < n; i++) {
      const score = dets[i * 5 + 4]
      if (score < minScore) continue
      if (labels && Number(labels[i]) !== 0) continue // person
      boxes.push({
        x0: region.x + dets[i * 5] / s,
        y0: region.y + dets[i * 5 + 1] / s,
        x1: region.x + dets[i * 5 + 2] / s,
        y1: region.y + dets[i * 5 + 3] / s,
        score,
      })
    }
    return boxes
  }

  /** Keypoints for one person box (top-down: crop with 25% padding at the model's 3:4 aspect). */
  async estimate(rgb: Uint8Array, w: number, h: number, box: Box): Promise<Keypoints> {
    const cx = (box.x0 + box.x1) / 2
    const cy = (box.y0 + box.y1) / 2
    let sw = (box.x1 - box.x0) * 1.25
    let sh = (box.y1 - box.y0) * 1.25
    const aspect = POSE_W / POSE_H
    if (sw > sh * aspect) sh = sw / aspect
    else sw = sh * aspect
    const left = cx - sw / 2
    const top = cy - sh / 2
    const kx = sw / POSE_W
    const ky = sh / POSE_H
    const plane = POSE_W * POSE_H
    const input = new Float32Array(3 * plane)
    const mean = [123.675, 116.28, 103.53]
    const std = [58.395, 57.12, 57.375]
    for (let y = 0; y < POSE_H; y++) {
      const sy = top + (y + 0.5) * ky - 0.5
      const fy = sy - Math.floor(sy)
      const y0 = Math.floor(sy)
      for (let x = 0; x < POSE_W; x++) {
        const sx = left + (x + 0.5) * kx - 0.5
        const fx = sx - Math.floor(sx)
        const x0 = Math.floor(sx)
        const o = y * POSE_W + x
        const inside = x0 >= 0 && y0 >= 0 && x0 + 1 < w && y0 + 1 < h
        for (let c = 0; c < 3; c++) {
          const v = inside ? lerp2(rgb, w, x0, x0 + 1, y0, y0 + 1, fx, fy, c) : 0
          input[c * plane + o] = (v - mean[c]) / std[c]
        }
      }
    }
    const out = await this.pose.run({ [this.pose.inputNames[0]]: new this.ort.Tensor('float32', input, [1, 3, POSE_H, POSE_W]) })
    const sx = out.simcc_x.data as Float32Array
    const sy = out.simcc_y.data as Float32Array
    const nx = out.simcc_x.dims[2]
    const ny = out.simcc_y.dims[2]
    const kps = new Float32Array(51)
    for (let k = 0; k < 17; k++) {
      let bx = 0
      let vx = -Infinity
      for (let i = 0; i < nx; i++) if (sx[k * nx + i] > vx) (vx = sx[k * nx + i]), (bx = i)
      let by = 0
      let vy = -Infinity
      for (let i = 0; i < ny; i++) if (sy[k * ny + i] > vy) (vy = sy[k * ny + i]), (by = i)
      kps[k * 3] = left + (bx / SIMCC_SPLIT) * kx
      kps[k * 3 + 1] = top + (by / SIMCC_SPLIT) * ky
      kps[k * 3 + 2] = Math.max(0, Math.min(vx, vy))
    }
    return kps
  }

  async release(): Promise<void> {
    await Promise.all([this.det.release(), this.pose.release()])
  }
}

/** Box around confident keypoints, padded – used to follow a player between detector runs. */
export function boxFromKeypoints(k: Keypoints, minScore = 0.3): Box | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    n = 0,
    s = 0
  for (let i = 0; i < 17; i++) {
    if (k[i * 3 + 2] < minScore) continue
    x0 = Math.min(x0, k[i * 3])
    x1 = Math.max(x1, k[i * 3])
    y0 = Math.min(y0, k[i * 3 + 1])
    y1 = Math.max(y1, k[i * 3 + 1])
    s += k[i * 3 + 2]
    n++
  }
  if (n < 6) return null
  const pw = (x1 - x0) * 0.15 + 4
  const ph = (y1 - y0) * 0.12 + 4
  return { x0: x0 - pw, y0: y0 - ph, x1: x1 + pw, y1: y1 + ph, score: s / n }
}

export function meanScore(k: Keypoints): number {
  let s = 0
  for (let i = 0; i < 17; i++) s += k[i * 3 + 2]
  return s / 17
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const inter = ix * iy
  const u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter
  return u > 0 ? inter / u : 0
}

function lerp2(rgb: Uint8Array, w: number, x0: number, x1: number, y0: number, y1: number, fx: number, fy: number, c: number): number {
  const a = rgb[(y0 * w + x0) * 3 + c]
  const b = rgb[(y0 * w + x1) * 3 + c]
  const d = rgb[(y1 * w + x0) * 3 + c]
  const e = rgb[(y1 * w + x1) * 3 + c]
  return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy
}

function clampInt(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v
}
