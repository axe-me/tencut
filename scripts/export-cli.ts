// Dev helper: node --experimental-strip-types scripts/export-cli.ts analysis.json segs.json out.mp4 [res] [codec] [maxClips]
import { readFileSync } from 'node:fs'
import { exportClips } from '../src/core/export.ts'
import type { Segment, ExportOptions } from '../src/core/types.ts'
const [json, segsFile, out, res = '1080p', codec = 'h264', max = '9999'] = process.argv.slice(2)
const a = JSON.parse(readFileSync(json, 'utf8'))
const segs: Segment[] = JSON.parse(readFileSync(segsFile, 'utf8')).slice(0, Number(max))
const o: ExportOptions = { outputPath: out, resolution: res as any, container: 'mp4', codec: codec as any, quality: 60, hardware: true, fadeMs: 0 }
let last = 0
const h = exportClips(segs.map((s) => ({ source: a.source, start: s.start, end: s.end })), o, (p) => {
  if (Date.now() - last > 1500 || p.fraction === 1) { last = Date.now(); console.log(p.phase, (p.fraction * 100).toFixed(1) + '%', p.message, p.etaSec?.toFixed(0) ?? '') }
})
const r = await h.done
console.log(r)
