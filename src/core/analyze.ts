/**
 * Full-source analysis, streaming and parallel:
 *  - audio: one ffmpeg process → 16 kHz mono PCM → OnsetDetector (whole file in a few seconds)
 *  - video: the timeline is split into chunks; a pool of worker threads each runs its own ffmpeg
 *    (hardware decode → downscale → crop to the court ROI) and extracts per-frame features.
 * Nothing ever holds more than a few decoded frames per worker.
 */
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { OnsetDetector, AUDIO_SR } from './audio.ts'
import { bbox, polygonMask, roiPolygon } from './court.ts'
import { ffmpegPath, hwDecodeArgs, probe, runFfmpeg } from './ffmpeg.ts'
import { trackBalls } from './tracker.ts'
import type { AnalysisResult, AudioFeatures, CourtCalibration, Progress, SourceInfo, VideoFeatures } from './types.ts'
import type { ChunkJob, ChunkResult, WorkerIn, WorkerMsg } from './video-worker.ts'

export const ANALYSIS_VERSION = 1

export interface AnalyzeOptions {
  court: CourtCalibration | null
  /** URL/path of the compiled video-worker module. */
  workerUrl: URL | string
  fps?: number
  /** Width of the full frame at analysis scale. */
  analysisWidth?: number
  concurrency?: number
  chunkSec?: number
  signal?: AbortSignal
  onProgress?: (p: Progress) => void
  source?: SourceInfo
}

export async function analyze(path: string, o: AnalyzeOptions): Promise<AnalysisResult> {
  const t0 = Date.now()
  const source = o.source ?? (await probe(path))
  const fps = o.fps ?? 15
  const concurrency = o.concurrency ?? Math.max(2, Math.min(6, Math.floor(cpus().length / 2)))
  const chunkSec = o.chunkSec ?? 90

  // Analysis geometry: downscale the whole frame to analysisWidth, then crop to the ROI's bounding box.
  const rw = Math.min(source.width, o.analysisWidth ?? 1280) & ~1
  const rh = Math.round((source.height * rw) / source.width) & ~1
  let crop = { x: 0, y: 0, w: rw, h: rh }
  let mask: Uint8Array
  if (o.court) {
    const poly = roiPolygon(o.court, rw, rh)
    const b = bbox(poly)
    const x = Math.max(0, Math.floor(b.x0) & ~1)
    const y = Math.max(0, Math.floor(b.y0) & ~1)
    crop = { x, y, w: Math.min(rw - x, (Math.ceil(b.x1 - x) + 1) & ~1), h: Math.min(rh - y, (Math.ceil(b.y1 - y) + 1) & ~1) }
    mask = polygonMask(
      poly.map((p) => ({ x: p.x - crop.x, y: p.y - crop.y })),
      crop.w,
      crop.h,
    )
  } else {
    mask = new Uint8Array(rw * rh).fill(1)
  }

  const totalFrames = Math.floor(source.durationSec * fps)
  const chunkFrames = Math.round(chunkSec * fps)
  const jobs: ChunkJob[] = []
  for (let s = 0, id = 0; s < totalFrames; s += chunkFrames, id++) {
    jobs.push({
      id,
      ffmpeg: ffmpegPath(),
      path,
      fps,
      startFrame: s,
      endFrame: Math.min(totalFrames, s + chunkFrames),
      warmup: 3,
      scaleW: rw,
      scaleH: rh,
      crop,
      mask,
      hwArgs: hwDecodeArgs(),
    })
  }

  const progress = { audio: source.hasAudio ? 0 : 1, frames: 0 }
  const report = () => {
    const vf = progress.frames / Math.max(1, totalFrames)
    const fraction = Math.min(1, 0.92 * vf + 0.08 * progress.audio)
    const el = (Date.now() - t0) / 1000
    o.onProgress?.({
      phase: 'analyze',
      fraction,
      message: `Analyzing video ${(vf * 100).toFixed(0)}%`,
      etaSec: fraction > 0.02 ? (el / fraction) * (1 - fraction) : undefined,
    })
  }

  const audioP = source.hasAudio ? analyzeAudio(path, source.durationSec, o.signal, (f) => ((progress.audio = f), report())) : Promise.resolve(null)
  const chunks = await runPool(jobs, concurrency, o.workerUrl, o.signal, (n) => {
    progress.frames += n
    report()
  })
  const audio = await audioP

  const motion = new Array<number>(totalFrames).fill(0)
  const candidates: number[] = []
  chunks.sort((a, b) => a.startFrame - b.startFrame)
  for (const c of chunks) {
    for (let i = 0; i < c.motion.length; i++) motion[c.startFrame + i] = Math.round(c.motion[i] * 1e4) / 1e4
    for (const v of c.candidates) candidates.push(v)
  }
  const video: VideoFeatures = {
    fps,
    width: crop.w,
    height: crop.h,
    cropX: crop.x / rw,
    cropY: crop.y / rh,
    cropW: crop.w / rw,
    cropH: crop.h / rh,
    refWidth: rw,
    frameCount: totalFrames,
    motion,
    candidates,
  }
  const tracks = trackBalls(video)
  o.onProgress?.({ phase: 'analyze', fraction: 1, message: 'Done' })
  return {
    version: ANALYSIS_VERSION,
    source,
    court: o.court,
    video,
    audio,
    tracks,
    analyzedAt: new Date().toISOString(),
    elapsedSec: (Date.now() - t0) / 1000,
  }
}

export async function analyzeAudio(path: string, duration: number, signal: AbortSignal | undefined, onFrac: (f: number) => void): Promise<AudioFeatures> {
  const det = new OnsetDetector()
  const run = runFfmpeg(['-v', 'error', '-i', path, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(AUDIO_SR), '-f', 'f32le', 'pipe:1'])
  const kill = () => run.proc.kill('SIGKILL')
  signal?.addEventListener('abort', kill, { once: true })
  let leftover: Buffer = Buffer.alloc(0)
  let samples = 0
  run.proc.stdout!.on('data', (b: Buffer) => {
    const buf = leftover.length ? Buffer.concat([leftover, b]) : b
    const n = Math.floor(buf.length / 4)
    // Copy into an aligned Float32Array (Buffer offsets aren't guaranteed 4-byte aligned).
    const f = new Float32Array(n)
    for (let i = 0; i < n; i++) f[i] = buf.readFloatLE(i * 4)
    leftover = buf.subarray(n * 4)
    det.push(f)
    samples += n
    onFrac(Math.min(1, samples / AUDIO_SR / Math.max(1, duration)))
  })
  try {
    await run.done
  } finally {
    signal?.removeEventListener('abort', kill)
  }
  if (signal?.aborted) throw new Error('Cancelled')
  onFrac(1)
  return det.finish()
}

function runPool(
  jobs: ChunkJob[],
  concurrency: number,
  workerUrl: URL | string,
  signal: AbortSignal | undefined,
  onFrames: (n: number) => void,
): Promise<ChunkResult[]> {
  return new Promise((resolve, reject) => {
    const results: ChunkResult[] = []
    const workers: Worker[] = []
    let next = 0
    let finished = false
    const fail = (e: Error) => {
      if (finished) return
      finished = true
      for (const w of workers) {
        w.postMessage({ type: 'cancel' } satisfies WorkerIn)
        setTimeout(() => w.terminate(), 200)
      }
      reject(e)
    }
    signal?.addEventListener('abort', () => fail(new Error('Cancelled')), { once: true })
    const feed = (w: Worker) => {
      if (finished) return
      if (next >= jobs.length) {
        w.terminate()
        if (results.length === jobs.length) {
          finished = true
          resolve(results)
        }
        return
      }
      const job = jobs[next++]
      w.postMessage({ type: 'job', job } satisfies WorkerIn)
    }
    const n = Math.min(concurrency, jobs.length)
    if (n === 0) return resolve([])
    for (let i = 0; i < n; i++) {
      const w = new Worker(workerUrl)
      workers.push(w)
      w.on('message', (m: WorkerMsg) => {
        if (m.type === 'progress') onFrames(m.frames)
        else if (m.type === 'error') fail(new Error(m.message))
        else if (m.type === 'done') {
          results.push(m.result)
          if (results.length === jobs.length) {
            finished = true
            for (const x of workers) x.terminate()
            resolve(results)
          } else feed(w)
        }
      })
      w.on('error', (e) => fail(e))
      feed(w)
    }
  })
}
