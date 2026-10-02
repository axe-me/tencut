// Headless analysis for development: node --experimental-strip-types scripts/analyze-cli.ts <video> [--court mode:x,y,x,y,x,y,x,y] [--out file.json]
import { writeFileSync } from 'node:fs'
import { analyze } from '../src/core/analyze.ts'
import type { CourtCalibration } from '../src/core/types.ts'

const args = process.argv.slice(2)
const file = args[0]
const opt = (k: string) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
let court: CourtCalibration | null = null
const c = opt('--court')
if (c) {
  const [mode, nums] = c.split(':')
  const v = nums.split(',').map(Number)
  court = { mode: mode as 'full' | 'half', corners: [0, 1, 2, 3].map((i) => ({ x: v[2 * i], y: v[2 * i + 1] })) as CourtCalibration['corners'] }
}
const out = opt('--out') ?? 'analysis.json'
const start = Date.now()
let last = 0
const res = await analyze(file, {
  court,
  workerUrl: new URL('../src/core/video-worker.ts', import.meta.url),
  concurrency: opt('--jobs') ? Number(opt('--jobs')) : undefined,
  onProgress: (p) => {
    if (Date.now() - last > 2000) {
      last = Date.now()
      console.log(`${(p.fraction * 100).toFixed(1)}%  eta ${p.etaSec?.toFixed(0) ?? '?'}s  rss ${(process.memoryUsage().rss / 1e6).toFixed(0)}MB`)
    }
  },
})
writeFileSync(out, JSON.stringify(res))
console.log(`done in ${((Date.now() - start) / 1000).toFixed(1)}s; ${res.tracks.length} ball tracks, ${res.audio?.hits.length ?? 0} audio hits, ${res.video.candidates.length / 4} candidates`)
