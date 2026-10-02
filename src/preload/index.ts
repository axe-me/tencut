import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AnalysisResult, CourtCalibration, ExportOptions, Progress, SourceInfo } from '../core/types'
import type { Clip } from '../core/export'
import type { LutInfo } from '../main/luts'

export interface AnalysisSettings {
  court: CourtCalibration | null
  pose: boolean
  lutId: string | null
}

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
  frame: (path: string, t: number, width: number, lutId?: string | null): Promise<string> => ipcRenderer.invoke('media:frame', path, t, width, lutId),
  mediaUrl: (path: string): string => `tencut-media://file/?p=${encodeURIComponent(path)}`,
  /** Cached per-file analyses (null where missing), in the order given. */
  cachedAnalysis: (paths: string[], settings: AnalysisSettings): Promise<(AnalysisResult | null)[]> =>
    ipcRenderer.invoke('analysis:cached', paths, settings),
  /** Analyse every file that isn't cached yet; resolves with all per-file results in order. */
  analyze: (paths: string[], settings: AnalysisSettings, sources: SourceInfo[]): Promise<AnalysisResult[]> =>
    ipcRenderer.invoke('analysis:run', paths, settings, sources),
  luts: {
    list: (): Promise<{ luts: LutInfo[]; defaultId: string | null }> => ipcRenderer.invoke('luts:list'),
    /** Opens a file dialog; resolves with the imported LUT (copied into the library) or null if cancelled. */
    import: (): Promise<LutInfo | null> => ipcRenderer.invoke('luts:import'),
    importPath: (path: string): Promise<LutInfo> => ipcRenderer.invoke('luts:importPath', path),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('luts:remove', id),
    setDefault: (id: string | null): Promise<void> => ipcRenderer.invoke('luts:setDefault', id),
    data: (id: string): Promise<{ size: number; data: Float32Array; domainMin: number[]; domainMax: number[] }> => ipcRenderer.invoke('luts:data', id),
  },
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
