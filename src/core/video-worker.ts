/**
 * worker_threads entry: decodes one time chunk with ffmpeg and streams frames through FrameAnalyzer.
 * Memory use is bounded by a handful of frames regardless of chunk length.
 */
import { parentPort } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { FrameAnalyzer } from './video.ts'
import { PlayerTracker } from './players.ts'
import { lutFilter } from './lut.ts'
import type { Point } from './types.ts'

export interface ChunkJob {
  id: number
  ffmpeg: string
  path: string
  fps: number
  /** First and one-past-last global frame indices this chunk is responsible for. */
  startFrame: number
  endFrame: number
  /** Extra frames decoded before startFrame to prime the 3-frame window. */
  warmup: number
  scaleW: number
  scaleH: number
  crop: { x: number; y: number; w: number; h: number }
  mask: Uint8Array
  hwArgs: string[]
  /** Colour LUT applied before analysis (log footage → normal colours): folder + plain file name. */
  lut?: { dir: string; file: string }
  /** Player pose: model files and the court floor polygon (crop pixels). Omitted = no pose. */
  pose?: { detector: string; model: string; ground: Point[]; every: number; detectEvery: number; threads: number }
}

export interface ChunkResult {
  id: number
  startFrame: number
  motion: Float32Array
  candidates: number[]
  /** POSE_STRIDE values per player per pose frame (see players.ts). */
  pose: number[]
}

export type WorkerMsg =
  | { type: 'progress'; id: number; frames: number }
  | { type: 'done'; result: ChunkResult }
  | { type: 'error'; id: number; message: string }

let current: ReturnType<typeof spawn> | null = null

let poseCache: { key: string; tracker: Promise<import('./pose.ts').PoseRunner> } | null = null

/** One pose runner per worker thread, created lazily and reused across chunks. */
async function poseRunner(p: NonNullable<ChunkJob['pose']>) {
  const key = `${p.detector}|${p.model}|${p.threads}`
  if (!poseCache || poseCache.key !== key) {
    poseCache = {
      key,
      tracker: (async () => {
        const [{ PoseRunner }, ortMod] = await Promise.all([import('./pose.ts'), import('onnxruntime-node')])
        const ort = (ortMod as any).default ?? ortMod
        return PoseRunner.create(ort, { detector: p.detector, pose: p.model }, p.threads)
      })(),
    }
  }
  return poseCache.tracker
}

async function runChunk(job: ChunkJob): Promise<ChunkResult> {
  const firstFrame = Math.max(0, job.startFrame - job.warmup)
  const t0 = firstFrame / job.fps
  const nFrames = job.endFrame - firstFrame
  const dur = nFrames / job.fps
  const { w, h, x, y } = job.crop
  const grade = job.lut ? `${lutFilter(job.lut.file)},` : ''
  const vf = `fps=${job.fps},scale=${job.scaleW}:${job.scaleH}:flags=fast_bilinear,crop=${w}:${h}:${x}:${y},${grade}format=rgb24`
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    ...job.hwArgs,
    '-ss', t0.toFixed(4),
    '-i', job.path,
    '-t', dur.toFixed(4),
    '-an', '-sn', '-dn',
    '-vf', vf,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ]
  const players = job.pose
    ? new PlayerTracker(await poseRunner(job.pose), { ground: job.pose.ground, detectEvery: job.pose.detectEvery, maxPlayers: 4 })
    : null
  const proc = spawn(job.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: job.lut?.dir })
  current = proc
  let err = ''
  proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) => resolve(code))
  })

  const frameBytes = w * h * 3
  const frame = new Uint8Array(frameBytes)
  let fill = 0
  let local = 0 // index of frames decoded in this chunk
  const an = new FrameAnalyzer({ width: w, height: h, mask: job.mask })
  const total = job.endFrame - job.startFrame
  const motion = new Float32Array(total)
  const candidates: number[] = []
  const pose: number[] = []
  let lastReport = 0

  const handleFrame = async () => {
    const g = firstFrame + local // global index of this frame
    const { motion: m, candidates: c } = an.push(frame)
    if (g >= job.startFrame && g < job.endFrame) {
      motion[g - job.startFrame] = m
      // Pose on a fixed global grid of frames so chunk boundaries don't shift the sampling.
      if (players && g % job.pose!.every === 0) await players.process(g, frame, w, h, pose)
    }
    // Candidates refer to the previous frame.
    const gc = g - 1
    if (gc >= job.startFrame && gc < job.endFrame) {
      for (let i = 0; i < c.length; i += 4) candidates.push(gc, c[i], c[i + 1], c[i + 2], c[i + 3])
    }
    local++
    if (local - lastReport >= 30) {
      parentPort!.postMessage({ type: 'progress', id: job.id, frames: local - lastReport } satisfies WorkerMsg)
      lastReport = local
    }
  }

  // for-await gives backpressure: ffmpeg is paused while a frame (and its pose inference) is processed.
  for await (const buf of proc.stdout as AsyncIterable<Buffer>) {
    let off = 0
    while (off < buf.length) {
      const n = Math.min(frameBytes - fill, buf.length - off)
      frame.set(buf.subarray(off, off + n), fill)
      fill += n
      off += n
      if (fill === frameBytes) {
        await handleFrame()
        fill = 0
      }
    }
  }
  const code = await exited
  if (code !== 0) throw new Error(`ffmpeg chunk ${job.id} exited ${code}: ${err.trim()}`)
  if (local - lastReport > 0) parentPort!.postMessage({ type: 'progress', id: job.id, frames: local - lastReport } satisfies WorkerMsg)
  return { id: job.id, startFrame: job.startFrame, motion, candidates, pose }
}

export type WorkerIn = { type: 'job'; job: ChunkJob } | { type: 'cancel' }

parentPort?.on('message', async (msg: WorkerIn) => {
  if (msg.type === 'cancel') {
    current?.kill('SIGKILL')
    return
  }
  const job = msg.job
  try {
    const result = await runChunk(job)
    parentPort!.postMessage({ type: 'done', result } satisfies WorkerMsg, [result.motion.buffer as ArrayBuffer])
  } catch (e) {
    parentPort!.postMessage({ type: 'error', id: job.id, message: (e as Error).message } satisfies WorkerMsg)
  }
})
