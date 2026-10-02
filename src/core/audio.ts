/**
 * Streaming racket-impact detector.
 *
 * Mono float32 PCM at 16 kHz is consumed in arbitrary chunks. For each 10 ms hop we compute the positive
 * spectral flux of log-magnitudes in the 1–6 kHz band, weighted by spectral flatness (impacts are short,
 * broadband "pocks"; voices and squeaks are tonal). Only that envelope (100 values/s) is kept; peak picking
 * with an adaptive threshold happens once the stream ends.
 */
import type { AudioFeatures } from './types.ts'

export const AUDIO_SR = 16000
const N = 512
const HOP = 160
const LO_BIN = Math.floor((1000 * N) / AUDIO_SR)
const HI_BIN = Math.ceil((6000 * N) / AUDIO_SR)

export class OnsetDetector {
  private ring = new Float32Array(N)
  private ringFill = 0
  private sinceHop = 0
  private prevLog: Float32Array | null = null
  private re = new Float64Array(N)
  private im = new Float64Array(N)
  private win = new Float64Array(N)
  private env: number[] = []

  constructor() {
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      // Shift-register via circular write; we unroll when computing a frame.
      this.ring[this.ringFill % N] = samples[i]
      this.ringFill++
      this.sinceHop++
      if (this.ringFill >= N && this.sinceHop >= HOP) {
        this.sinceHop = 0
        this.frame()
      }
    }
  }

  private frame(): void {
    const start = this.ringFill % N
    const { re, im, win } = this
    for (let i = 0; i < N; i++) {
      re[i] = this.ring[(start + i) % N] * win[i]
      im[i] = 0
    }
    fft(re, im)
    const bins = HI_BIN - LO_BIN
    const log = new Float32Array(bins)
    let flux = 0
    let geo = 0
    let ari = 0
    for (let k = 0; k < bins; k++) {
      const b = k + LO_BIN
      const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b])
      const l = Math.log1p(100 * mag)
      log[k] = l
      geo += Math.log(mag + 1e-9)
      ari += mag
      if (this.prevLog) {
        const d = l - this.prevLog[k]
        if (d > 0) flux += d
      }
    }
    const flat = Math.exp(geo / bins) / (ari / bins + 1e-9) // 0 (tonal) .. 1 (noise)
    this.prevLog = log
    this.env.push(flux * (0.35 + Math.min(1, flat * 2)))
  }

  /** Finish: returns normalized onset envelope and detected hits. */
  finish(): AudioFeatures {
    return onsetsFromEnvelope(Float32Array.from(this.env), HOP / AUDIO_SR)
  }
}

export function onsetsFromEnvelope(env: Float32Array, hop: number): AudioFeatures {
  const n = env.length
  // Local baseline: running median over ~1 s; noise scale: running median absolute deviation over ~20 s.
  const base = runningMedian(env, Math.round(1 / hop) | 1)
  const dev = new Float32Array(n)
  for (let i = 0; i < n; i++) dev[i] = Math.abs(env[i] - base[i])
  const noise = runningMedian(dev, Math.round(20 / hop) | 1)
  let gm = 0
  for (let i = 0; i < n; i++) gm += noise[i]
  const floor = (gm / Math.max(1, n)) * 0.25 + 1e-6
  const z = new Float32Array(n)
  for (let i = 0; i < n; i++) z[i] = Math.max(0, env[i] - base[i]) / (1.4826 * Math.max(noise[i], floor))

  // Peak pick: local max within ±120 ms and above an absolute z threshold.
  const hits: { t: number; s: number }[] = []
  const w = Math.round(0.12 / hop)
  const T = 8
  for (let i = 1; i < n - 1; i++) {
    const v = z[i]
    if (v < T) continue
    let isMax = true
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) {
      if (z[k] > v || (z[k] === v && k < i)) {
        isMax = false
        break
      }
    }
    if (isMax) hits.push({ t: Math.round(i * hop * 1000) / 1000, s: Math.round(v * 10) / 10 })
  }
  const onset = new Array<number>(n)
  for (let i = 0; i < n; i++) onset[i] = Math.round(Math.min(99, z[i]) * 10) / 10
  return { hop, onset, hits }
}

/**
 * Running median (or other percentile) with a sliding window, computed on a decimated grid for speed and
 * linearly interpolated back. Accurate enough for baselines.
 */
export function runningMedian(x: Float32Array, win: number, pct = 50): Float32Array {
  const n = x.length
  const out = new Float32Array(n)
  if (n === 0) return out
  const step = Math.max(1, Math.floor(win / 10))
  const half = Math.floor(win / 2)
  const gridIdx: number[] = []
  const gridVal: number[] = []
  const buf: number[] = []
  for (let c = 0; c < n; c += step) {
    buf.length = 0
    for (let k = Math.max(0, c - half); k <= Math.min(n - 1, c + half); k++) buf.push(x[k])
    buf.sort((a, b) => a - b)
    gridIdx.push(c)
    gridVal.push(buf[Math.min(buf.length - 1, Math.floor((pct / 100) * buf.length))])
  }
  let g = 0
  for (let i = 0; i < n; i++) {
    while (g + 1 < gridIdx.length && gridIdx[g + 1] <= i) g++
    if (g + 1 < gridIdx.length) {
      const t = (i - gridIdx[g]) / (gridIdx[g + 1] - gridIdx[g])
      out[i] = gridVal[g] * (1 - t) + gridVal[g + 1] * t
    } else out[i] = gridVal[g]
  }
  return out
}

/** In-place iterative radix-2 complex FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}
