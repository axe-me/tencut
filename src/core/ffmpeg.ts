import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import type { SourceInfo } from './types.ts'

const require = createRequire(import.meta.url)

function unpacked(p: string): string {
  // Binaries inside an Electron asar archive can't be executed; electron-builder unpacks them next to it.
  return p.replace(`app.asar${pathSep()}`, `app.asar.unpacked${pathSep()}`)
}
function pathSep(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

let ffmpegPathCache: string | null = null
let ffprobePathCache: string | null = null

export function ffmpegPath(): string {
  if (ffmpegPathCache) return ffmpegPathCache
  const env = process.env.TENCUT_FFMPEG
  if (env && existsSync(env)) return (ffmpegPathCache = env)
  const p = require('ffmpeg-static') as string
  return (ffmpegPathCache = unpacked(p))
}

export function ffprobePath(): string {
  if (ffprobePathCache) return ffprobePathCache
  const env = process.env.TENCUT_FFPROBE
  if (env && existsSync(env)) return (ffprobePathCache = env)
  const p = (require('ffprobe-static') as { path: string }).path
  return (ffprobePathCache = unpacked(p))
}

function parseRate(r: string | undefined): number {
  if (!r) return 0
  const [a, b] = r.split('/').map(Number)
  return b ? a / b : a
}

export async function probe(path: string): Promise<SourceInfo> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      ffprobePath(),
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
    )
  })
  const j = JSON.parse(out)
  const streams: any[] = j.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!v) throw new Error('No video stream found')
  const a = streams.find((s) => s.codec_type === 'audio')
  let rotation = 0
  for (const sd of v.side_data_list ?? []) if (typeof sd.rotation === 'number') rotation = sd.rotation
  if (v.tags?.rotate) rotation = Number(v.tags.rotate)
  const duration = Number(v.duration ?? j.format?.duration ?? 0)
  return {
    path,
    durationSec: duration,
    width: v.width,
    height: v.height,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30,
    videoCodec: v.codec_name,
    pixFmt: v.pix_fmt,
    hasAudio: !!a,
    audioSampleRate: a ? Number(a.sample_rate) : 0,
    sizeBytes: statSync(path).size,
    rotation,
  }
}

export interface FfmpegRun {
  proc: ChildProcess
  done: Promise<void>
}

/** Spawn ffmpeg; rejects with the tail of stderr on non-zero exit. */
export function runFfmpeg(args: string[], opts: { onStderr?: (line: string) => void } = {}): FfmpegRun {
  const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  let buf = ''
  proc.stderr!.setEncoding('utf8')
  proc.stderr!.on('data', (d: string) => {
    tail = (tail + d).slice(-4000)
    if (opts.onStderr) {
      buf += d
      const lines = buf.split(/[\r\n]/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l) opts.onStderr(l)
    }
  })
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(signal ? `ffmpeg killed (${signal})` : `ffmpeg exited ${code}: ${tail.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
  return { proc, done }
}

/** Hardware decode flags for the current platform. ffmpeg silently falls back to software if unavailable. */
export function hwDecodeArgs(): string[] {
  if (process.platform === 'darwin') return ['-hwaccel', 'videotoolbox']
  if (process.platform === 'win32') return ['-hwaccel', 'auto']
  return []
}

let encoderCache: Set<string> | null = null
export async function availableEncoders(): Promise<Set<string>> {
  if (encoderCache) return encoderCache
  const out = await new Promise<string>((resolve) => {
    execFile(ffmpegPath(), ['-hide_banner', '-encoders'], { maxBuffer: 4 * 1024 * 1024 }, (_e, stdout) => resolve(stdout ?? ''))
  })
  const set = new Set<string>()
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*[VAS][\w.]{5}\s+(\S+)/)
    if (m) set.add(m[1])
  }
  return (encoderCache = set)
}

const HW_CANDIDATES: Record<string, ('videotoolbox' | 'nvenc' | 'qsv' | 'amf')[]> = {
  darwin: ['videotoolbox'],
  // NVIDIA, Intel Quick Sync, AMD – whichever GPU the machine actually has.
  win32: ['nvenc', 'qsv', 'amf'],
  linux: ['nvenc', 'qsv'],
}

const hwProbeCache = new Map<string, Promise<boolean>>()

/** ffmpeg lists e.g. h264_nvenc even without an NVIDIA GPU; the only reliable check is a tiny test encode. */
function encoderWorks(name: string): Promise<boolean> {
  let p = hwProbeCache.get(name)
  if (!p) {
    p = new Promise<boolean>((resolve) => {
      execFile(
        ffmpegPath(),
        ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30', '-frames:v', '10', '-c:v', name, '-f', 'null', '-'],
        { timeout: 15000 },
        (err) => resolve(!err),
      )
    })
    hwProbeCache.set(name, p)
  }
  return p
}

/** First working hardware encoder for the codec on this machine, e.g. 'h264_videotoolbox' or 'hevc_nvenc'. */
export async function hardwareEncoder(codec: 'h264' | 'hevc'): Promise<string | null> {
  const listed = await availableEncoders()
  for (const kind of HW_CANDIDATES[process.platform] ?? []) {
    const name = `${codec}_${kind}`
    if (listed.has(name) && (await encoderWorks(name))) return name
  }
  return null
}
