import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AnalysisResult, CourtCalibration, ExportOptions, Progress, SourceInfo } from '../core/types'
import type { Clip } from '../core/export'

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: unknown, v: T) => cb(v)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

const api = {
  openVideos: (): Promise<string[] | null> => ipcRenderer.invoke('dialog:openVideos'),
  saveOutput: (defaultName: string, ext: string): Promise<string | null> => ipcRenderer.invoke('dialog:saveOutput', defaultName, ext),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  probe: (path: string): Promise<SourceInfo> => ipcRenderer.invoke('media:probe', path),
  frame: (path: string, t: number, width: number): Promise<string> => ipcRenderer.invoke('media:frame', path, t, width),
  mediaUrl: (path: string): string => `tencut-media://file/?p=${encodeURIComponent(path)}`,
  /** Cached per-file analyses (null where missing), in the order given. */
  cachedAnalysis: (paths: string[], court: CourtCalibration | null, pose: boolean): Promise<(AnalysisResult | null)[]> =>
    ipcRenderer.invoke('analysis:cached', paths, court, pose),
  /** Analyse every file that isn't cached yet; resolves with all per-file results in order. */
  analyze: (paths: string[], court: CourtCalibration | null, sources: SourceInfo[], pose: boolean): Promise<AnalysisResult[]> =>
    ipcRenderer.invoke('analysis:run', paths, court, sources, pose),
  poseAvailable: (): Promise<boolean> => ipcRenderer.invoke('analysis:poseAvailable'),
  cancelAnalysis: (): Promise<void> => ipcRenderer.invoke('analysis:cancel'),
  onAnalysisProgress: (cb: (p: Progress) => void) => on('analysis:progress', cb),
  loadProject: (paths: string[]): Promise<unknown> => ipcRenderer.invoke('project:load', paths),
  saveProject: (paths: string[], state: unknown): Promise<void> => ipcRenderer.invoke('project:save', paths, state),
  estimateExport: (clips: Clip[], o: ExportOptions): Promise<number> => ipcRenderer.invoke('export:estimate', clips, o),
  exportClips: (clips: Clip[], o: ExportOptions): Promise<{ outputPath: string; bytes: number; elapsedSec: number }> => ipcRenderer.invoke('export:run', clips, o),
  cancelExport: (): Promise<void> => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb: (p: Progress) => void) => on('export:progress', cb),
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:open', path),
  defaultOutputName: (src: string, ext: string): Promise<string> => ipcRenderer.invoke('app:defaultOutputName', src, ext),
  platform: process.platform,
}

export type TenCutApi = typeof api
contextBridge.exposeInMainWorld('tencut', api)
