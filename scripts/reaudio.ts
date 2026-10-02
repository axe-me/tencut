// Dev helper: recompute only the audio features of an existing analysis JSON.
import { readFileSync, writeFileSync } from 'node:fs'
import { analyzeAudio } from '../src/core/analyze.ts'
const [file, json] = process.argv.slice(2)
const res = JSON.parse(readFileSync(json, 'utf8'))
res.audio = await analyzeAudio(file, res.source.durationSec, undefined, () => {})
writeFileSync(json, JSON.stringify(res))
const hits = res.audio.hits
console.log('hits', hits.length, 'per min', (hits.length / (res.source.durationSec / 60)).toFixed(1))
