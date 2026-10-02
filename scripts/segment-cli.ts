// Dev helper: segment an analysis JSON. node --experimental-strip-types scripts/segment-cli.ts analysis.json [sensitivity] [out.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { segmentRallies, estimateShots, totalDuration } from '../src/core/segment.ts'
import { DEFAULT_SEGMENT_PARAMS } from '../src/core/types.ts'
const [json, sens, out] = process.argv.slice(2)
const a = JSON.parse(readFileSync(json, 'utf8'))
const segs = segmentRallies(a, { ...DEFAULT_SEGMENT_PARAMS, sensitivity: sens ? Number(sens) : 0.5 })
for (const s of segs) console.log(`${s.start.toFixed(1).padStart(7)} – ${s.end.toFixed(1).padStart(7)}  ${(s.end - s.start).toFixed(1).padStart(5)}s  score ${s.score.toFixed(2)}  shots ${estimateShots(a, s.start, s.end)}`)
console.log(`${segs.length} rallies, kept ${totalDuration(segs).toFixed(0)}s of ${a.source.durationSec.toFixed(0)}s`)
if (out) writeFileSync(out, JSON.stringify(segs))
