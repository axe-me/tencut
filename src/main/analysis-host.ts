/**
 * Electron utilityProcess entry. Hosts the analysis pipeline (ffmpeg processes + worker threads) out of the
 * main process so the UI stays responsive and a crash here can't take the app down.
 */
import { analyze } from '../core/analyze'
import type { AnalysisResult, CourtCalibration, Progress, SourceInfo } from '../core/types'

export type HostIn =
  | {
      type: 'analyze'
      path: string
      court: CourtCalibration | null
      source: SourceInfo
      ffmpeg?: string
      ffprobe?: string
      pose?: { detector: string; model: string }
    }
  | { type: 'cancel' }

export type HostOut =
  | { type: 'progress'; progress: Progress }
  | { type: 'result'; result: AnalysisResult }
  | { type: 'error'; message: string }

const port = process.parentPort
let ctrl: AbortController | null = null

port.on('message', async (e: { data: HostIn }) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    ctrl?.abort()
    return
  }
  if (msg.type === 'analyze') {
    if (msg.ffmpeg) process.env.TENCUT_FFMPEG = msg.ffmpeg
    if (msg.ffprobe) process.env.TENCUT_FFPROBE = msg.ffprobe
    ctrl = new AbortController()
    try {
      const result = await analyze(msg.path, {
        court: msg.court,
        source: msg.source,
        workerUrl: new URL('./video-worker.js', import.meta.url),
        signal: ctrl.signal,
        pose: msg.pose,
        onProgress: (progress) => port.postMessage({ type: 'progress', progress } satisfies HostOut),
      })
      port.postMessage({ type: 'result', result } satisfies HostOut)
    } catch (err) {
      port.postMessage({ type: 'error', message: (err as Error).message } satisfies HostOut)
    } finally {
      ctrl = null
    }
  }
})
