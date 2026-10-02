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
  cachedAnalysis: (path: string, court: CourtCalibration | null): Promise<AnalysisResult | null> => ipcRenderer.invoke('analysis:cached', path, court),
  analyze: (path: string, court: CourtCalibration | null, source: SourceInfo): Promise<AnalysisResult> => ipcRenderer.invoke('analysis:run', path, court, source),
  cancelAnalysis: (): Promise<void> => ipcRenderer.invoke('analysis:cancel'),
  onAnalysisProgress: (cb: (p: Progress) => void) => on('analysis:progress', cb),
  loadProject: (path: string): Promise<unknown> => ipcRenderer.invoke('project:load', path),
  saveProject: (path: string, state: unknown): Promise<void> => ipcRenderer.invoke('project:save', path, state),
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
