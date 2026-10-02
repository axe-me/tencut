import { app, BrowserWindow, dialog, ipcMain, protocol, shell, utilityProcess, type UtilityProcess } from 'electron'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ffmpegPath, ffprobePath, probe, runFfmpeg } from '../core/ffmpeg'
import { exportClips, estimateSizeBytes, type Clip, type ExportHandle } from '../core/export'
import { ANALYSIS_VERSION } from '../core/analyze'
import type { AnalysisResult, CourtCalibration, ExportOptions, Progress, SourceInfo } from '../core/types'
import type { HostIn, HostOut } from './analysis-host'

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null

// Packaged builds get the name from the bundle; set it explicitly so development runs match (About panel,
// dock, userData folder).
app.setName('TenCut')

// Bundled ffprobe (see scripts/fetch-ffprobe.mjs): Contents/Resources/bin when packaged, resources/bin in dev.
{
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const p = app.isPackaged ? join(process.resourcesPath, 'bin', exe) : join(here, '../../resources/bin', exe)
  if (!process.env.TENCUT_FFPROBE && existsSync(p)) process.env.TENCUT_FFPROBE = p
}
const devIcon = join(here, '../../resources/icon.png')

protocol.registerSchemesAsPrivileged([
  { scheme: 'tencut-media', privileges: { standard: true, stream: true, supportFetchAPI: true, secure: true, corsEnabled: true } },
])

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0f1115',
    title: 'TenCut',
    icon: !app.isPackaged && existsSync(devIcon) ? devIcon : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Windows/Linux keep the native frame; the menu bar shows with Alt.
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(here, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

// ---- Media protocol: lets <video> stream local files with Range support (needed for seeking huge files).
function registerMediaProtocol(): void {
  protocol.handle('tencut-media', async (req) => {
    const url = new URL(req.url)
    const path = decodeURIComponent(url.searchParams.get('p') ?? '')
    if (!path || !existsSync(path)) return new Response('not found', { status: 404 })
    const size = statSync(path).size
    const type = mimeFor(path)
    const range = req.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? Number(m[1]) : 0
      let end = m && m[2] ? Number(m[2]) : size - 1
      if (!m?.[1] && m?.[2]) {
        start = size - Number(m[2])
        end = size - 1
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream
    return new Response(stream, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
  })
}

function mimeFor(p: string): string {
  const e = extname(p).toLowerCase()
  if (e === '.mov') return 'video/quicktime'
  if (e === '.mkv') return 'video/x-matroska'
  if (e === '.webm') return 'video/webm'
  return 'video/mp4'
}

// ---- Persistence: analysis cache + project state, keyed by file identity.
function dataDir(sub: string): string {
  const d = join(app.getPath('userData'), sub)
  mkdirSync(d, { recursive: true })
  return d
}

function fileKey(path: string): string {
  const st = statSync(path)
  return createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
}

function courtKey(c: CourtCalibration | null): string {
  return c ? createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 8) : 'nocourt'
}

function readCached(path: string, court: CourtCalibration | null, pose: boolean): AnalysisResult | null {
  const p = cachePath(path, court, pose && !!poseModels())
  if (!existsSync(p)) return null
  try {
    return forRenderer(JSON.parse(readFileSync(p, 'utf8')) as AnalysisResult)
  } catch {
    return null
  }
}

/** A match is identified by its ordered list of files (a single file keeps its original key). */
function projectKey(paths: string[]): string {
  if (paths.length === 1) return fileKey(paths[0])
  return createHash('sha1').update(paths.map(fileKey).join('|')).digest('hex').slice(0, 16)
}

function cachePath(path: string, court: CourtCalibration | null, pose: boolean): string {
  return join(dataDir('analysis'), `${fileKey(path)}-${courtKey(court)}-${pose ? 'pose' : 'nopose'}-v${ANALYSIS_VERSION}.json`)
}

/** Bundled ONNX models: resources/models in development, Contents/Resources/models when packaged. */
function poseModels(): { detector: string; model: string } | undefined {
  const dir = app.isPackaged ? join(process.resourcesPath, 'models') : join(here, '../../resources/models')
  const detector = join(dir, 'yolox-tiny-humanart.onnx')
  const model = join(dir, 'rtmpose-t-body7.onnx')
  return existsSync(detector) && existsSync(model) ? { detector, model } : undefined
}

/** The renderer only needs derived pose events; raw keypoints (several MB) stay in the cache file. */
function forRenderer(r: AnalysisResult): AnalysisResult {
  const { players: _players, ...rest } = r
  return rest
}

// ---- Analysis host (utilityProcess)
let host: UtilityProcess | null = null

function runAnalysis(
  path: string,
  court: CourtCalibration | null,
  source: SourceInfo,
  usePose: boolean,
  onProgress: (p: Progress) => void,
): Promise<AnalysisResult> {
  const pose = usePose ? poseModels() : undefined
  return new Promise((resolve, reject) => {
    host?.kill()
    const child = utilityProcess.fork(join(here, 'analysis-host.js'), [], { serviceName: 'TenCut Analysis', stdio: 'inherit' })
    host = child
    let settled = false
    child.on('message', (m: HostOut) => {
      if (m.type === 'progress') onProgress(m.progress)
      else if (m.type === 'result') {
        settled = true
        try {
          writeFileSync(cachePath(path, court, !!pose), JSON.stringify(m.result))
        } catch (e) {
          console.warn('cache write failed', e)
        }
        resolve(forRenderer(m.result))
        child.kill()
      } else if (m.type === 'error') {
        settled = true
        reject(new Error(m.message))
        child.kill()
      }
    })
    child.on('exit', (code) => {
      if (host === child) host = null
      if (!settled) reject(new Error(`Analysis process exited unexpectedly (${code})`))
    })
    child.postMessage({ type: 'analyze', path, court, source, ffmpeg: ffmpegPath(), ffprobe: ffprobePath(), pose } satisfies HostIn)
  })
}

// ---- IPC
let exportHandle: ExportHandle | null = null

function registerIpc(): void {
  ipcMain.handle('dialog:openVideos', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Open match recording',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'mts', 'm2ts', 'webm', 'MP4', 'MOV'] }],
    })
    return r.canceled ? null : r.filePaths
  })

  ipcMain.handle('dialog:saveOutput', async (_e, defaultName: string, ext: string) => {
    const r = await dialog.showSaveDialog(win!, {
      title: 'Export rallies',
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    return r.canceled ? null : r.filePath
  })

  ipcMain.handle('media:probe', (_e, path: string) => probe(path))

  ipcMain.handle('media:frame', async (_e, path: string, t: number, width: number) => {
    // Single JPEG frame for calibration / thumbnails. Fast: input seek + one decoded frame.
    const run = runFfmpeg(['-v', 'error', '-ss', String(Math.max(0, t)), '-i', path, '-frames:v', '1', '-vf', `scale=${Math.round(width)}:-2`, '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'])
    const chunks: Buffer[] = []
    run.proc.stdout!.on('data', (d: Buffer) => chunks.push(d))
    await run.done
    return `data:image/jpeg;base64,${Buffer.concat(chunks).toString('base64')}`
  })

  // Per-file results, in timeline order. Each file is cached on its own, so adding a file to a match only
  // analyses the new one.
  ipcMain.handle('analysis:cached', (_e, paths: string[], court: CourtCalibration | null, pose: boolean) =>
    paths.map((path) => readCached(path, court, pose)),
  )

  ipcMain.handle('analysis:run', async (_e, paths: string[], court: CourtCalibration | null, sources: SourceInfo[], pose: boolean) => {
    const total = sources.reduce((s, x) => s + x.durationSec, 0) || 1
    const out: AnalysisResult[] = []
    let done = 0
    const t0 = Date.now()
    for (let i = 0; i < paths.length; i++) {
      const cached = readCached(paths[i], court, pose)
      const dur = sources[i].durationSec
      if (cached) out.push(cached)
      else
        out.push(
          await runAnalysis(paths[i], court, sources[i], pose, (p) => {
            const fraction = (done + p.fraction * dur) / total
            const el = (Date.now() - t0) / 1000
            win?.webContents.send('analysis:progress', {
              ...p,
              fraction,
              message: paths.length > 1 ? `File ${i + 1} of ${paths.length}` : p.message,
              etaSec: fraction > 0.02 ? (el / fraction) * (1 - fraction) : undefined,
            } satisfies Progress)
          }),
        )
      done += dur
    }
    return out
  })
  ipcMain.handle('analysis:poseAvailable', () => !!poseModels())
  ipcMain.handle('analysis:cancel', () => host?.postMessage({ type: 'cancel' } satisfies HostIn))

  ipcMain.handle('project:load', (_e, paths: string[]) => {
    const p = join(dataDir('projects'), `${projectKey(paths)}.json`)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  })
  ipcMain.handle('project:save', (_e, paths: string[], state: unknown) => {
    writeFileSync(join(dataDir('projects'), `${projectKey(paths)}.json`), JSON.stringify(state))
  })

  ipcMain.handle('export:estimate', (_e, clips: Clip[], o: ExportOptions) => estimateSizeBytes(clips, o))
  ipcMain.handle('export:run', async (_e, clips: Clip[], o: ExportOptions) => {
    exportHandle = exportClips(clips, o, (p) => win?.webContents.send('export:progress', p))
    try {
      return await exportHandle.done
    } finally {
      exportHandle = null
    }
  })
  ipcMain.handle('export:cancel', () => exportHandle?.cancel())

  ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('shell:open', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('app:defaultOutputName', (_e, src: string, ext: string) => {
    const base = basename(src, extname(src))
    return join(dirname(src), `${base} - rallies.${ext}`)
  })
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'TenCut',
    applicationVersion: app.getVersion(),
    copyright: 'Keeps the rallies, cuts the rest. Runs entirely offline.',
    credits: 'Pose models: RTMPose & YOLOX (OpenMMLab, Apache-2.0). Video: FFmpeg.',
  })
  if (process.platform === 'darwin' && !app.isPackaged && existsSync(devIcon)) app.dock?.setIcon(devIcon)
  registerMediaProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  host?.kill()
  exportHandle?.cancel()
  app.quit()
})
