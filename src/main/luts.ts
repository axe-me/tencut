/**
 * The user's LUT library: imported .cube files are validated and copied into the app's data folder
 * (userData/luts/<id>.cube), so a LUT loaded once keeps working even if the original file moves. The last
 * LUT chosen becomes the default for new projects.
 */
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseCube } from '../core/lut'

export interface LutInfo {
  id: string
  name: string
  size: number
  addedAt: string
}

interface LibraryFile {
  luts: LutInfo[]
  defaultId: string | null
}

function dir(): string {
  const d = join(app.getPath('userData'), 'luts')
  mkdirSync(d, { recursive: true })
  return d
}

function indexPath(): string {
  return join(dir(), 'library.json')
}

function load(): LibraryFile {
  try {
    const j = JSON.parse(readFileSync(indexPath(), 'utf8')) as LibraryFile
    // Drop entries whose file was deleted behind our back.
    j.luts = j.luts.filter((l) => existsSync(lutFile(l.id)))
    if (j.defaultId && !j.luts.some((l) => l.id === j.defaultId)) j.defaultId = null
    return j
  } catch {
    return { luts: [], defaultId: null }
  }
}

function save(lib: LibraryFile): void {
  writeFileSync(indexPath(), JSON.stringify(lib, null, 2))
}

/** Absolute path of a library LUT; ids are hex so the file name is safe for ffmpeg filter arguments. */
export function lutFile(id: string): string {
  if (!/^[0-9a-f]{8,40}$/.test(id)) throw new Error('Invalid LUT id')
  return join(dir(), `${id}.cube`)
}

export function listLuts(): { luts: LutInfo[]; defaultId: string | null } {
  return load()
}

export function importLut(path: string): LutInfo {
  if (extname(path).toLowerCase() !== '.cube') throw new Error('Only .cube LUTs are supported')
  const text = readFileSync(path, 'utf8')
  const lut = parseCube(text) // validates; throws with a readable message
  const id = createHash('sha1').update(text).digest('hex').slice(0, 16)
  const lib = load()
  let info = lib.luts.find((l) => l.id === id)
  if (!info) {
    copyFileSync(path, lutFile(id))
    info = { id, name: basename(path, extname(path)), size: lut.size, addedAt: new Date().toISOString() }
    lib.luts.push(info)
  }
  lib.defaultId = id
  save(lib)
  return info
}

export function removeLut(id: string): void {
  const lib = load()
  lib.luts = lib.luts.filter((l) => l.id !== id)
  if (lib.defaultId === id) lib.defaultId = null
  rmSync(lutFile(id), { force: true })
  save(lib)
}

export function setDefaultLut(id: string | null): void {
  const lib = load()
  lib.defaultId = id && lib.luts.some((l) => l.id === id) ? id : null
  save(lib)
}

/** Parsed table for the WebGL preview (size³ RGB floats). */
export function lutData(id: string): { size: number; data: Float32Array; domainMin: number[]; domainMax: number[] } {
  const lut = parseCube(readFileSync(lutFile(id), 'utf8'))
  return { size: lut.size, data: lut.data, domainMin: lut.domainMin, domainMax: lut.domainMax }
}

export function lutExists(id: string | null | undefined): id is string {
  return !!id && /^[0-9a-f]{8,40}$/.test(id) && existsSync(lutFile(id))
}
