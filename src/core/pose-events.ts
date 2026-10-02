/**
 * Turns raw player keypoints into tennis events:
 *  - swings: the wrist whips round relative to the shoulders (normalised by torso length, so it works for the
 *    near player and the much smaller far player alike); overhead if the hitting arm is above the head
 *  - pickups: a player bent over (shoulders dropped towards the hips) – ball collection between points
 */
import { COURT_L, COURT_W, courtToImage, invert, apply, type Mat3 } from './court.ts'
import { KP } from './pose.ts'
import { POSE_STRIDE } from './players.ts'
import type { CourtCalibration, PlayerPoses, PoseEvents, Swing, VideoFeatures } from './types.ts'

export interface PoseRecord {
  frame: number
  id: number
  kps: Float32Array
}

export function encodePoses(raw: number[], every: number): PlayerPoses {
  const n = raw.length / POSE_STRIDE
  const out = new Int16Array(n * 55)
  for (let r = 0; r < n; r++) {
    const b = r * POSE_STRIDE
    const o = r * 55
    const f = raw[b]
    out[o] = Math.floor(f / 32768)
    out[o + 1] = f % 32768
    out[o + 2] = raw[b + 1] % 32768
    for (let k = 0; k < 17; k++) {
      out[o + 3 + k * 3] = Math.round(raw[b + 2 + k * 3] * 2)
      out[o + 4 + k * 3] = Math.round(raw[b + 3 + k * 3] * 2)
      out[o + 5 + k * 3] = Math.round(raw[b + 4 + k * 3] * 1000)
    }
  }
  return { every, count: n, data: toBase64(new Uint8Array(out.buffer)) }
}

export function decodePoses(p: PlayerPoses): PoseRecord[] {
  const bytes = fromBase64(p.data)
  const a = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const out: PoseRecord[] = []
  for (let r = 0; r < p.count; r++) {
    const o = r * 55
    const kps = new Float32Array(51)
    for (let k = 0; k < 17; k++) {
      kps[k * 3] = a[o + 3 + k * 3] / 2
      kps[k * 3 + 1] = a[o + 4 + k * 3] / 2
      kps[k * 3 + 2] = a[o + 5 + k * 3] / 1000
    }
    out.push({ frame: a[o] * 32768 + a[o + 1], id: a[o + 2], kps })
  }
  return out
}

const MIN_KP = 0.3
/**
 * Wrist speed relative to the shoulders (torso lengths per second) that can be a swing. Sampled at 5 fps a
 * stroke peaks around 4–8; walking arm swing stays under ~2.5. Ball bouncing before a serve also reaches this,
 * which is why the segmenter only trusts swings that alternate between the two ends of the court.
 */
export const SWING_SPEED = 3.5
/** The wrist must also sweep at least this far (torso lengths, relative to the shoulders) around the peak. */
const SWING_SWEEP = 1.0

interface Sample {
  t: number
  feet: { x: number; y: number }
  height: number
  torso: number | null
  shoulder: { x: number; y: number } | null
  hip: { x: number; y: number } | null
  wrists: ({ x: number; y: number } | null)[]
  noseY: number | null
  side: 'near' | 'far'
  /** Feet inside the court lines (±1 m); false when unknown. */
  onCourt: boolean
}

export function derivePoseEvents(records: PoseRecord[], v: VideoFeatures, court: CourtCalibration | null, every: number): PoseEvents {
  const fps = v.fps
  const dt = every / fps
  const refH = v.height / Math.max(1e-6, v.cropH)
  const toCourt: Mat3 | null = court ? invert(courtToImage(court, v.refWidth, refH)) : null
  const ox = v.cropX * v.refWidth
  const oy = v.cropY * refH

  const samples = records.map((r) => sample(r, fps, toCourt, ox, oy))
  // Link samples into per-player tracks across chunk boundaries: same side, feet close, small time gap.
  const tracks: Sample[][] = []
  const frames = new Map<number, Sample[]>()
  for (const s of samples) {
    const k = Math.round(s.t * fps)
    if (!frames.has(k)) frames.set(k, [])
    frames.get(k)!.push(s)
  }
  let live: Sample[][] = []
  for (const k of [...frames.keys()].sort((a, b) => a - b)) {
    const t = k / fps
    live = live.filter((tr) => t - tr[tr.length - 1].t <= 3 * dt + 1e-6)
    const used = new Set<Sample[]>()
    for (const s of frames.get(k)!) {
      let best: Sample[] | null = null
      let bestD = Infinity
      for (const tr of live) {
        if (used.has(tr)) continue
        const last = tr[tr.length - 1]
        if (last.side !== s.side) continue
        const d = Math.hypot(last.feet.x - s.feet.x, last.feet.y - s.feet.y) / Math.max(10, last.height)
        if (d < 0.8 && d < bestD) (best = tr), (bestD = d)
      }
      if (best) best.push(s)
      else {
        best = [s]
        tracks.push(best)
        live.push(best)
      }
      used.add(best)
    }
  }

  const swings: Swing[] = []
  const pickups: number[] = []
  for (const tr of tracks) {
    const torsos = tr.map((s) => s.torso).filter((x): x is number => x !== null)
    if (torsos.length < 3) continue
    torsos.sort((a, b) => a - b)
    const refTorso = torsos[Math.floor(torsos.length * 0.75)] // upright torso length
    const speed: number[] = new Array(tr.length).fill(0)
    for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1]
      const b = tr[i]
      const gap = b.t - a.t
      if (gap > 2.5 * dt || !a.shoulder || !b.shoulder) continue
      let m = 0
      for (let w = 0; w < 2; w++) {
        const wa = a.wrists[w]
        const wb = b.wrists[w]
        if (!wa || !wb) continue
        const dx = wb.x - b.shoulder.x - (wa.x - a.shoulder.x)
        const dy = wb.y - b.shoulder.y - (wa.y - a.shoulder.y)
        m = Math.max(m, Math.hypot(dx, dy) / refTorso / gap)
      }
      speed[i] = m
    }
    let lastSwing = -Infinity
    for (let i = 1; i < tr.length; i++) {
      const sp = speed[i]
      if (sp < SWING_SPEED) continue
      // Peak within ±0.4 s only.
      let isPeak = true
      for (let j = i - 1; j >= 0 && tr[i].t - tr[j].t <= 0.4; j--) if (speed[j] > sp) isPeak = false
      for (let j = i + 1; j < tr.length && tr[j].t - tr[i].t <= 0.4; j++) if (speed[j] > sp) isPeak = false
      if (!isPeak) continue
      if (tr[i].t - lastSwing < 0.6) continue
      if (sweep(tr, i, 0.4) < SWING_SWEEP * refTorso) continue
      const overhead = [tr[i], tr[i - 1]].some((s) => isOverhead(s, refTorso))
      swings.push({ t: round2((tr[i].t + tr[i - 1].t) / 2), side: tr[i].side, overhead, speed: Math.round(sp * 10) / 10 })
      lastSwing = tr[i].t
    }
    // Upright: hips sit about one torso length below the shoulders. Bent over: that drops below half.
    // Picking up a ball is a short episode by someone on the court itself; long "bent" stretches are people
    // sitting or crouching at the side, and are ignored.
    let ep: Sample[] = []
    const flush = () => {
      if (ep.length && ep[ep.length - 1].t - ep[0].t <= 3 && ep.every((x) => x.onCourt)) pickups.push(round2((ep[0].t + ep[ep.length - 1].t) / 2))
      ep = []
    }
    for (const s of tr) {
      const bent = !!s.shoulder && !!s.hip && s.hip.y - s.shoulder.y < 0.45 * refTorso
      if (bent && (!ep.length || s.t - ep[ep.length - 1].t <= 2.5 * dt)) ep.push(s)
      else {
        flush()
        if (bent) ep.push(s)
      }
    }
    flush()
  }
  swings.sort((a, b) => a.t - b.t)
  pickups.sort((a, b) => a - b)
  const sampleFrames = new Set(records.map((r) => r.frame)).size
  const expected = Math.max(1, Math.floor(v.frameCount / every))
  return { swings, pickups, coverage: Math.round((sampleFrames / expected) * 100) / 100 }
}

function sample(r: PoseRecord, fps: number, toCourt: Mat3 | null, ox: number, oy: number): Sample {
  const k = r.kps
  const pt = (i: number) => (k[i * 3 + 2] >= MIN_KP ? { x: k[i * 3], y: k[i * 3 + 1] } : null)
  const mid = (a: number, b: number) => {
    const p = pt(a)
    const q = pt(b)
    return p && q ? { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } : (p ?? q)
  }
  let y0 = Infinity
  let y1 = -Infinity
  for (let i = 0; i < 17; i++) if (k[i * 3 + 2] >= MIN_KP) (y0 = Math.min(y0, k[i * 3 + 1])), (y1 = Math.max(y1, k[i * 3 + 1]))
  const ankles = mid(KP.lAnkle, KP.rAnkle)
  const shoulder = mid(KP.lShoulder, KP.rShoulder)
  const hip = mid(KP.lHip, KP.rHip)
  const feet = ankles ?? { x: shoulder?.x ?? 0, y: y1 }
  let side: 'near' | 'far' = 'near'
  let onCourt = false
  if (toCourt) {
    const c = apply(toCourt, { x: feet.x + ox, y: feet.y + oy })
    side = c.y > COURT_L / 2 ? 'far' : 'near'
    onCourt = c.x > -1 && c.x < COURT_W + 1 && c.y > -1 && c.y < COURT_L + 1
  }
  const torso = shoulder && hip && pt(KP.lShoulder) && pt(KP.lHip) ? Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) : null
  const nose = pt(KP.nose)
  return {
    t: r.frame / fps,
    feet,
    height: isFinite(y1 - y0) ? y1 - y0 : 0,
    torso,
    shoulder,
    hip,
    wrists: [pt(KP.lWrist), pt(KP.rWrist)],
    noseY: nose ? nose.y : null,
    side,
    onCourt,
  }
}

/** Largest wrist excursion relative to the shoulders within ±win seconds of sample i (pixels). */
function sweep(tr: Sample[], i: number, win: number): number {
  let best = 0
  for (let w = 0; w < 2; w++) {
    const pts: { x: number; y: number }[] = []
    for (let j = i; j >= 0 && tr[i].t - tr[j].t <= win; j--) {
      const s = tr[j]
      if (s.wrists[w] && s.shoulder) pts.push({ x: s.wrists[w]!.x - s.shoulder.x, y: s.wrists[w]!.y - s.shoulder.y })
    }
    for (let j = i + 1; j < tr.length && tr[j].t - tr[i].t <= win; j++) {
      const s = tr[j]
      if (s.wrists[w] && s.shoulder) pts.push({ x: s.wrists[w]!.x - s.shoulder.x, y: s.wrists[w]!.y - s.shoulder.y })
    }
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) best = Math.max(best, Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y))
  }
  return best
}

function isOverhead(s: Sample, refTorso: number): boolean {
  const head = s.noseY ?? (s.shoulder ? s.shoulder.y - 0.35 * refTorso : null)
  if (head === null) return false
  return s.wrists.some((w) => w !== null && w.y < head - 0.25 * refTorso)
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function toBase64(b: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

function fromBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const b = Buffer.from(s, 'base64')
    return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  }
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
