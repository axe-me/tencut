// Downloads ffprobe for this platform into resources/bin (runs as npm postinstall, so `npm ci` on CI does it too).
// Same release as the ffmpeg that ffmpeg-static installs (b6.1.1), so both tools are the same version.
//   node scripts/fetch-ffprobe.mjs [--force]
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'

const RELEASE = process.env.TENCUT_FFPROBE_RELEASE || 'b6.1.1'
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`
const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = `${process.platform}-${process.arch}`
const outDir = join(root, 'resources', 'bin')
const exe = join(outDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

if (!SUPPORTED.includes(target)) {
  console.warn(`[fetch-ffprobe] no ffprobe build for ${target}; skipping`)
  process.exit(0)
}
if (existsSync(exe) && statSync(exe).size > 1e6 && !process.argv.includes('--force')) {
  console.log(`[fetch-ffprobe] ${exe} already present`)
  process.exit(0)
}

async function download(url, dest, gunzip) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`)
  const tmp = `${dest}.download`
  const stages = [Readable.fromWeb(res.body)]
  if (gunzip) stages.push(createGunzip())
  await pipeline(...stages, createWriteStream(tmp))
  renameSync(tmp, dest)
}

mkdirSync(outDir, { recursive: true })
try {
  console.log(`[fetch-ffprobe] downloading ffprobe ${RELEASE} for ${target}…`)
  await download(`${BASE}/ffprobe-${target}.gz`, exe, true)
  if (process.platform !== 'win32') chmodSync(exe, 0o755)
  await download(`${BASE}/${target}.LICENSE`, join(outDir, 'ffprobe.LICENSE'), false).catch(() => {})
  console.log(`[fetch-ffprobe] wrote ${exe} (${(statSync(exe).size / 1e6).toFixed(0)} MB)`)
} catch (e) {
  rmSync(`${exe}.download`, { force: true })
  console.error(`[fetch-ffprobe] failed: ${e.message}`)
  // Don't break `npm install` offline; the app reports a clear error if ffprobe is missing.
  process.exit(0)
}
