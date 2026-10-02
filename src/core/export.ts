/**
 * Export kept segments as one video.
 *
 * Each clip is encoded on its own (seeking straight to it, so dead time is never decoded), with identical
 * encoder settings, into a temp folder next to the output. The parts are then joined with the concat demuxer
 * without re-encoding. This bounds memory, gives exact progress, and lets 2 clips encode in parallel.
 * In 'copy' mode clips are cut on keyframes without re-encoding (fast, original quality, cuts snap a little earlier).
 */
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { availableEncoders, hwDecodeArgs, runFfmpeg, type FfmpegRun } from './ffmpeg.ts'
import type { ExportOptions, Progress, SourceInfo } from './types.ts'
import { targetSize } from './resolutions.ts'
export { allowedResolutions, targetSize } from './resolutions.ts'

export interface Clip {
  source: SourceInfo
  start: number
  end: number
}

/** Video bitrate in kbit/s for a given output size, codec and quality (0..100). */
export function videoBitrate(w: number, h: number, fps: number, codec: 'h264' | 'hevc', quality: number): number {
  // ~0.11 bits/pixel/frame at 30 fps for good H.264 sports footage; HEVC needs ~60%.
  const bpp = 0.11 * (codec === 'hevc' ? 0.6 : 1) * (0.5 + quality / 100)
  return Math.round((w * h * Math.min(fps, 60) * bpp) / 1000)
}

export function estimateSizeBytes(clips: Clip[], o: ExportOptions): number {
  let bytes = 0
  for (const c of clips) {
    const d = c.end - c.start
    if (o.codec === 'copy') bytes += (c.source.sizeBytes / c.source.durationSec) * d
    else {
      const { w, h } = targetSize(c.source, o.resolution)
      bytes += ((videoBitrate(w, h, c.source.fps, o.codec, o.quality) + 192) * 1000 * d) / 8
    }
  }
  return bytes
}

async function encoderArgs(o: ExportOptions, src: SourceInfo): Promise<string[]> {
  if (o.codec === 'copy') return ['-c', 'copy']
  const enc = await availableEncoders()
  const { w, h } = targetSize(src, o.resolution)
  const kbps = videoBitrate(w, h, src.fps, o.codec, o.quality)
  const tenBit = /10|12/.test(src.pixFmt)
  const args: string[] = []
  if (o.codec === 'hevc') {
    if (o.hardware && enc.has('hevc_videotoolbox')) {
      args.push('-c:v', 'hevc_videotoolbox', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`)
      if (tenBit) args.push('-pix_fmt', 'p010le', '-profile:v', 'main10')
      else args.push('-pix_fmt', 'yuv420p')
    } else if (enc.has('libx265')) {
      args.push('-c:v', 'libx265', '-preset', 'fast', '-b:v', `${kbps}k`, '-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p')
    } else throw new Error('No HEVC encoder available')
    args.push('-tag:v', 'hvc1')
  } else {
    if (o.hardware && enc.has('h264_videotoolbox')) {
      args.push('-c:v', 'h264_videotoolbox', '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`, '-profile:v', 'high')
    } else if (enc.has('libx264')) {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(Math.round(28 - o.quality / 10)))
    } else throw new Error('No H.264 encoder available')
    args.push('-pix_fmt', 'yuv420p')
  }
  // Fixed GOP keeps joins clean; constant frame rate output.
  const fps = src.fps > 0 ? src.fps : 30
  args.push('-g', String(Math.round(fps * 2)), '-fps_mode', 'cfr', '-r', fpsString(fps))
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
  return args
}

function fpsString(fps: number): string {
  // Map common NTSC rates back to exact fractions.
  for (const [num, den] of [[24000, 1001], [30000, 1001], [60000, 1001]] as const) if (Math.abs(fps - num / den) < 0.01) return `${num}/${den}`
  return String(Math.round(fps * 1000) / 1000)
}

export interface ExportHandle {
  done: Promise<{ outputPath: string; bytes: number; elapsedSec: number }>
  cancel: () => void
}

export function exportClips(clips: Clip[], o: ExportOptions, onProgress?: (p: Progress) => void): ExportHandle {
  const running = new Set<FfmpegRun>()
  let cancelled = false
  const cancel = () => {
    cancelled = true
    for (const r of running) r.proc.kill('SIGKILL')
  }
  const done = (async () => {
    if (clips.length === 0) throw new Error('Nothing to export – no segments are kept')
    const t0 = Date.now()
    const outDir = dirname(o.outputPath)
    const partsDir = join(outDir, `.${basename(o.outputPath)}.parts`)
    mkdirSync(partsDir, { recursive: true })
    const total = clips.reduce((s, c) => s + (c.end - c.start), 0)
    const prog = new Array<number>(clips.length).fill(0)
    const report = (phase: string) => {
      const doneSec = prog.reduce((a, b) => a + b, 0)
      const f = Math.min(1, doneSec / total) * 0.97
      const el = (Date.now() - t0) / 1000
      onProgress?.({ phase, fraction: f, message: `Encoding ${fmt(doneSec)} / ${fmt(total)}`, etaSec: f > 0.02 ? (el / f) * (1 - f) : undefined })
    }
    const ext = o.codec === 'copy' ? (o.container === 'mov' ? 'mov' : 'mkv') : 'mp4'
    const parts = clips.map((_, i) => join(partsDir, `part${String(i).padStart(4, '0')}.${o.codec === 'copy' ? ext : 'mp4'}`))

    try {
      const fade = Math.max(0, o.fadeMs) / 1000
      const encodeOne = async (i: number) => {
        const c = clips[i]
        const dur = c.end - c.start
        const args: string[] = ['-v', 'error', '-progress', 'pipe:1', '-nostats']
        if (o.codec !== 'copy') args.push(...hwDecodeArgs())
        args.push('-ss', c.start.toFixed(3), '-i', c.source.path, '-t', dur.toFixed(3))
        args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1')
        if (o.codec !== 'copy') {
          const filters: string[] = []
          if (o.resolution !== 'source') {
            const { w, h } = targetSize(c.source, o.resolution)
            if (w !== c.source.width || h !== c.source.height) filters.push(`scale=${w}:${h}:flags=lanczos`)
          }
          if (fade > 0) filters.push(`fade=t=in:st=0:d=${fade}`, `fade=t=out:st=${Math.max(0, dur - fade).toFixed(3)}:d=${fade}`)
          if (filters.length) args.push('-vf', filters.join(','))
          // Short audio fades always: avoids clicks at every cut.
          const af = Math.max(fade, 0.03)
          args.push('-af', `afade=t=in:st=0:d=${af},afade=t=out:st=${Math.max(0, dur - af).toFixed(3)}:d=${af}`)
        }
        args.push(...(await encoderArgs(o, c.source)))
        if (o.codec !== 'copy' || ext !== 'mkv') args.push('-write_tmcd', '0')
        args.push('-avoid_negative_ts', 'make_zero', '-y', parts[i])
        const run = runFfmpeg(args)
        running.add(run)
        let buf = ''
        run.proc.stdout!.setEncoding('utf8')
        run.proc.stdout!.on('data', (d: string) => {
          buf += d
          const m = [...buf.matchAll(/out_time_us=(\d+)/g)]
          if (m.length) {
            prog[i] = Math.min(dur, Number(m[m.length - 1][1]) / 1e6)
            buf = buf.slice(buf.lastIndexOf('out_time_us='))
            report('encode')
          }
        })
        try {
          await run.done
        } finally {
          running.delete(run)
        }
        prog[i] = dur
        report('encode')
      }

      // Small pool: hardware encoders have limited sessions; 2 keeps both media engines busy.
      const conc = o.codec === 'copy' ? 4 : 2
      let next = 0
      await Promise.all(
        Array.from({ length: Math.min(conc, clips.length) }, async () => {
          while (next < clips.length && !cancelled) await encodeOne(next++)
        }),
      )
      if (cancelled) throw new Error('Cancelled')

      onProgress?.({ phase: 'join', fraction: 0.98, message: 'Joining clips' })
      const list = join(partsDir, 'list.txt')
      writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'))
      const joinArgs = ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy']
      if (o.container !== 'mkv') joinArgs.push('-movflags', '+faststart')
      if (o.codec === 'hevc' && o.container !== 'mkv') joinArgs.push('-tag:v', 'hvc1')
      joinArgs.push('-y', o.outputPath)
      const j = runFfmpeg(joinArgs)
      running.add(j)
      await j.done
      running.delete(j)
      onProgress?.({ phase: 'done', fraction: 1, message: 'Done' })
      return { outputPath: o.outputPath, bytes: existsSync(o.outputPath) ? statSync(o.outputPath).size : 0, elapsedSec: (Date.now() - t0) / 1000 }
    } catch (e) {
      if (cancelled) {
        try {
          rmSync(o.outputPath, { force: true })
        } catch {}
        throw new Error('Cancelled')
      }
      throw e
    } finally {
      rmSync(partsDir, { recursive: true, force: true })
    }
  })()
  return { done, cancel }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${m}:${String(ss).padStart(2, '0')}`
}
