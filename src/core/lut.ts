/**
 * 3D colour LUTs (.cube) – e.g. DJI D-Log M or Sony S-Log3 → Rec.709.
 *
 * The same LUT is applied in three places: the WebGL preview (parsed here, uploaded as a 3D texture), the
 * analysis decode (so detection sees normal colours instead of flat log) and the export (ffmpeg lut3d).
 */

export interface CubeLut {
  title: string
  size: number
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  /** size³ RGB triplets, red changing fastest (the .cube order, and WebGL's x-fastest 3D texture order). */
  data: Float32Array
}

export function parseCube(text: string): CubeLut {
  let size = 0
  let title = ''
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  let data: Float32Array | null = null
  let n = 0
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const c = line.charCodeAt(0)
    const numeric = (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43
    if (!numeric) {
      const [key, ...rest] = line.split(/\s+/)
      const k = key.toUpperCase()
      if (k === 'TITLE') title = rest.join(' ').replace(/^"|"$/g, '')
      else if (k === 'LUT_3D_SIZE') size = Number(rest[0])
      else if (k === 'LUT_1D_SIZE') throw new Error('1D LUTs aren’t supported – export a 3D .cube from your grading app')
      else if (k === 'DOMAIN_MIN') domainMin = rest.slice(0, 3).map(Number) as [number, number, number]
      else if (k === 'DOMAIN_MAX') domainMax = rest.slice(0, 3).map(Number) as [number, number, number]
      continue
    }
    if (!size) throw new Error('LUT_3D_SIZE missing before the table')
    if (!data) data = new Float32Array(size * size * size * 3)
    const parts = line.split(/\s+/)
    if (parts.length < 3 || n + 3 > data.length) throw new Error(`Unexpected LUT row: "${line.slice(0, 40)}"`)
    data[n++] = Number(parts[0])
    data[n++] = Number(parts[1])
    data[n++] = Number(parts[2])
  }
  if (!size || size < 2 || size > 256) throw new Error('Not a 3D .cube LUT (missing or invalid LUT_3D_SIZE)')
  if (!data || n !== size * size * size * 3) throw new Error(`LUT has ${n / 3} entries, expected ${size ** 3}`)
  return { title, size, domainMin, domainMax, data }
}

/**
 * ffmpeg filter that applies a LUT. The file name must be a plain name relative to ffmpeg's working directory
 * (callers run ffmpeg with cwd = the LUT folder) – that avoids filtergraph escaping of drive letters,
 * backslashes and quotes in full paths. Converting to 16-bit RGB first keeps 10-bit log footage from banding.
 */
export function lutFilter(fileName: string): string {
  if (!/^[\w.-]+$/.test(fileName)) throw new Error(`Unsafe LUT file name: ${fileName}`)
  return `format=rgb48le,lut3d=file=${fileName}:interp=tetrahedral`
}
