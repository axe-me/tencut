import { app, BrowserWindow, dialog, ipcMain, protocol, shell, utilityProcess, type UtilityProcess } from 'electron'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ffmpegPath, ffprobePath, probe, runFfmpeg } from '../core/ffmpeg'
import { exportClips, estimateSizeBytes, type Clip, type ExportHandle } from '../core/export'
import { ANALYSIS_VERSION } from '../core/analyze'
import type { AnalysisResult, CourtCalibration, ExportOptions, SourceInfo } from '../core/types'
import type { HostIn, HostOut } from './analysis-host'

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null

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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

function cachePath(path: string, court: CourtCalibration | null): string {
  return join(dataDir('analysis'), `${fileKey(path)}-${courtKey(court)}-v${ANALYSIS_VERSION}.json`)
}

// ---- Analysis host (utilityProcess)
let host: UtilityProcess | null = null

function runAnalysis(path: string, court: CourtCalibration | null, source: SourceInfo): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    host?.kill()
    const child = utilityProcess.fork(join(here, 'analysis-host.js'), [], { serviceName: 'TenCut Analysis', stdio: 'inherit' })
    host = child
    let settled = false
    child.on('message', (m: HostOut) => {
      if (m.type === 'progress') win?.webContents.send('analysis:progress', m.progress)
      else if (m.type === 'result') {
        settled = true
        try {
          writeFileSync(cachePath(path, court), JSON.stringify(m.result))
        } catch (e) {
          console.warn('cache write failed', e)
        }
        resolve(m.result)
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
    child.postMessage({ type: 'analyze', path, court, source, ffmpeg: ffmpegPath(), ffprobe: ffprobePath() } satisfies HostIn)
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

  ipcMain.handle('analysis:cached', (_e, path: string, court: CourtCalibration | null) => {
    const p = cachePath(path, court)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as AnalysisResult
    } catch {
      return null
    }
  })

  ipcMain.handle('analysis:run', (_e, path: string, court: CourtCalibration | null, source: SourceInfo) => runAnalysis(path, court, source))
  ipcMain.handle('analysis:cancel', () => host?.postMessage({ type: 'cancel' } satisfies HostIn))

  ipcMain.handle('project:load', (_e, path: string) => {
    const p = join(dataDir('projects'), `${fileKey(path)}.json`)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
  })
  ipcMain.handle('project:save', (_e, path: string, state: unknown) => {
    writeFileSync(join(dataDir('projects'), `${fileKey(path)}.json`), JSON.stringify(state))
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
