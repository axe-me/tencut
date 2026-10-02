/**
 * worker_threads entry: decodes one time chunk with ffmpeg and streams frames through FrameAnalyzer.
 * Memory use is bounded by a handful of frames regardless of chunk length.
 */
import { parentPort } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { FrameAnalyzer } from './video.ts'

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
}

export interface ChunkResult {
  id: number
  startFrame: number
  motion: Float32Array
  candidates: number[]
}

export type WorkerMsg =
  | { type: 'progress'; id: number; frames: number }
  | { type: 'done'; result: ChunkResult }
  | { type: 'error'; id: number; message: string }

let current: ReturnType<typeof spawn> | null = null

function runChunk(job: ChunkJob): Promise<ChunkResult> {
  return new Promise((resolve, reject) => {
    const firstFrame = Math.max(0, job.startFrame - job.warmup)
    const t0 = firstFrame / job.fps
    const nFrames = job.endFrame - firstFrame
    const dur = nFrames / job.fps
    const { w, h, x, y } = job.crop
    const vf = `fps=${job.fps},scale=${job.scaleW}:${job.scaleH}:flags=fast_bilinear,crop=${w}:${h}:${x}:${y},format=rgb24`
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
    const proc = spawn(job.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    current = proc
    let err = ''
    proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)))

    const frameBytes = w * h * 3
    const frame = new Uint8Array(frameBytes)
    let fill = 0
    let local = 0 // index of frames decoded in this chunk
    const an = new FrameAnalyzer({ width: w, height: h, mask: job.mask })
    const total = job.endFrame - job.startFrame
    const motion = new Float32Array(total)
    const candidates: number[] = []
    let lastReport = 0

    const handleFrame = () => {
      const g = firstFrame + local // global index of this frame
      const { motion: m, candidates: c } = an.push(frame)
      if (g >= job.startFrame && g < job.endFrame) motion[g - job.startFrame] = m
      // Candidates refer to the previous frame.
      const gc = g - 1
      if (gc >= job.startFrame && gc < job.endFrame) {
        for (let i = 0; i < c.length; i += 3) candidates.push(gc, c[i], c[i + 1], c[i + 2])
      }
      local++
      if (local - lastReport >= 30) {
        parentPort!.postMessage({ type: 'progress', id: job.id, frames: local - lastReport } satisfies WorkerMsg)
        lastReport = local
      }
    }

    proc.stdout.on('data', (buf: Buffer) => {
      let off = 0
      while (off < buf.length) {
        const n = Math.min(frameBytes - fill, buf.length - off)
        frame.set(buf.subarray(off, off + n), fill)
        fill += n
        off += n
        if (fill === frameBytes) {
          handleFrame()
          fill = 0
        }
      }
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg chunk ${job.id} exited ${code}: ${err.trim()}`))
      if (local - lastReport > 0) parentPort!.postMessage({ type: 'progress', id: job.id, frames: local - lastReport } satisfies WorkerMsg)
      resolve({ id: job.id, startFrame: job.startFrame, motion, candidates })
    })
  })
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
