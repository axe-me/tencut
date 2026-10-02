import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, courtToImage, homography, polygonMask, roiPolygon, COURT_L, COURT_W } from './court.ts'
import { fft, onsetsFromEnvelope, OnsetDetector, AUDIO_SR } from './audio.ts'
import { segmentRallies } from './segment.ts'
import { trackBalls } from './tracker.ts'
import { allowedResolutions, targetSize } from './resolutions.ts'
import { isBallColor } from './video.ts'
import { DEFAULT_SEGMENT_PARAMS, type AnalysisResult, type BallTrack, type CourtCalibration } from './types.ts'

test('homography maps the four reference points exactly', () => {
  const src = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const dst = [{ x: 10, y: 20 }, { x: 110, y: 25 }, { x: 90, y: 140 }, { x: 5, y: 120 }]
  const H = homography(src, dst)
  src.forEach((p, i) => {
    const q = apply(H, p)
    assert.ok(Math.abs(q.x - dst[i].x) < 1e-6 && Math.abs(q.y - dst[i].y) < 1e-6)
  })
})

test('half-court calibration places the net at the clicked points', () => {
  const cal: CourtCalibration = { mode: 'half', corners: [{ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.9 }, { x: 0.7, y: 0.5 }, { x: 0.3, y: 0.5 }] }
  const H = courtToImage(cal, 1000, 1000)
  const netRight = apply(H, { x: COURT_W, y: COURT_L / 2 })
  assert.ok(Math.abs(netRight.x - 700) < 1e-6 && Math.abs(netRight.y - 500) < 1e-6)
  const roi = roiPolygon(cal, 1000, 1000)
  const mask = polygonMask(roi, 1000, 1000)
  assert.equal(mask[700 * 1000 + 500], 1, 'court centre is inside the ROI')
})

test('fft finds a pure tone in the right bin', () => {
  const n = 512
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 32 * i) / n)
  fft(re, im)
  let best = 0
  for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[best], im[best])) best = k
  assert.equal(best, 32)
})

test('onset detector picks out isolated clicks in noise', () => {
  const det = new OnsetDetector()
  const secs = 30
  const x = new Float32Array(AUDIO_SR * secs)
  let seed = 1
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5)
  for (let i = 0; i < x.length; i++) x[i] = rnd() * 0.01
  const clicks = [5, 8.5, 12, 20.25]
  for (const t of clicks) for (let k = 0; k < 80; k++) x[Math.round(t * AUDIO_SR) + k] += rnd() * 1.5 * Math.exp(-k / 20)
  for (let i = 0; i < x.length; i += 4000) det.push(x.subarray(i, i + 4000))
  const { hits } = det.finish()
  for (const t of clicks) assert.ok(hits.some((h) => Math.abs(h.t - t) < 0.05), `click at ${t}s found`)
  assert.ok(hits.length <= clicks.length + 1, `few false hits (${hits.length})`)
})

test('onsetsFromEnvelope handles empty input', () => {
  assert.deepEqual(onsetsFromEnvelope(new Float32Array(0), 0.01).hits, [])
})

test('ball colour: optic yellow yes, court blue / curtain green no', () => {
  assert.equal(isBallColor(140, 170, 115), true)
  assert.equal(isBallColor(200, 220, 60), true)
  assert.equal(isBallColor(60, 90, 160), false)
  assert.equal(isBallColor(45, 105, 95), false)
})

function fakeAnalysis(tracks: BallTrack[], duration = 120): AnalysisResult {
  return {
    version: 1,
    source: { path: 'x', durationSec: duration, width: 3840, height: 2160, fps: 30, videoCodec: 'hevc', pixFmt: 'yuv420p', hasAudio: false, audioSampleRate: 0, sizeBytes: 1, rotation: 0 },
    court: null,
    video: { fps: 15, width: 1280, height: 720, cropX: 0, cropY: 0, cropW: 1, cropH: 1, refWidth: 1280, frameCount: duration * 15, motion: [], candidates: [] },
    audio: null,
    tracks,
    analyzedAt: '',
    elapsedSec: 0,
  }
}

/** A ball flight from t0 lasting d seconds, moving horizontally across the frame. */
function flight(t0: number, d: number, dir = 1): BallTrack {
  const pts: [number, number, number][] = []
  const n = Math.round(d * 15)
  for (let i = 0; i <= n; i++) pts.push([Math.round(t0 * 15) + i, 300 + dir * i * 30, 300 - 10 * Math.sin((i / n) * Math.PI)])
  return { start: pts[0][0], end: pts[n][0], speed: 30, reversals: 0, points: pts }
}

test('segmentation: a run of flights becomes one rally, isolated noise does not', () => {
  const tracks: BallTrack[] = []
  // Rally: 8 shots, 1.1 s flights with 0.3 s gaps, from 20 s.
  for (let i = 0; i < 8; i++) tracks.push(flight(20 + i * 1.4, 1.1, i % 2 ? -1 : 1))
  // A single stray flight at 80 s (ball fed back between points).
  tracks.push(flight(80, 0.6))
  const segs = segmentRallies(fakeAnalysis(tracks), DEFAULT_SEGMENT_PARAMS)
  assert.equal(segs.length, 1)
  assert.ok(segs[0].start <= 20 && segs[0].start >= 17, `starts with lead-in (${segs[0].start})`)
  assert.ok(segs[0].end >= 31 && segs[0].end <= 34, `ends after last shot (${segs[0].end})`)
})

test('segmentation: two points separated by a long break stay separate', () => {
  const tracks: BallTrack[] = []
  for (let i = 0; i < 5; i++) tracks.push(flight(10 + i * 1.3, 1, i % 2 ? -1 : 1))
  for (let i = 0; i < 5; i++) tracks.push(flight(40 + i * 1.3, 1, i % 2 ? -1 : 1))
  assert.equal(segmentRallies(fakeAnalysis(tracks), DEFAULT_SEGMENT_PARAMS).length, 2)
})

test('tracker links a fast moving candidate and rejects a slow one', () => {
  const a = fakeAnalysis([])
  const c: number[] = []
  for (let f = 0; f < 12; f++) {
    c.push(100 + f, 200 + f * 25, 300 + f * 2, 6, 0.05) // fast: ball
    c.push(100 + f, 900 + f * 1, 500, 8, 0.6) // slow, on a moving body: clothing
    c.push(100 + f, 300 + f * 5, 150 + f * 1, 5, 0.03) // slow but isolated and travelling: ball flying towards the camera
  }
  a.video.candidates = c
  const tracks = trackBalls(a.video)
  assert.equal(tracks.length, 2)
  assert.ok(tracks.every((t) => t.points[0][1] < 400), 'clothing track rejected')
})

test('serve: toss followed by a loud hit becomes a serve clip even without a rally', () => {
  const toss: BallTrack = { start: 600, end: 612, speed: 12, reversals: 0, points: [] }
  for (let i = 0; i <= 12; i++) toss.points.push([600 + i, 400 + (i % 2), 500 - 18 * Math.min(i, 10)])
  const a = fakeAnalysis([toss])
  a.audio = { hop: 0.01, onset: [], hits: [{ t: 41.0, s: 40 }] }
  const segs = segmentRallies(a, DEFAULT_SEGMENT_PARAMS)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, 'serve')
  assert.ok(segs[0].start < 40 && segs[0].end > 43, `covers toss → landing (${segs[0].start}-${segs[0].end})`)
})

test('resolutions never upscale', () => {
  assert.deepEqual(allowedResolutions({ width: 1920, height: 1080 }), ['720p', 'source'])
  assert.deepEqual(allowedResolutions({ width: 3840, height: 2160 }), ['720p', '1080p', '1440p', 'source'])
  assert.deepEqual(targetSize({ width: 3840, height: 2160 }, '1080p'), { w: 1920, h: 1080 })
  assert.deepEqual(targetSize({ width: 1080, height: 1920 }, '720p'), { w: 720, h: 1280 })
})

test('pose: alternating near/far swings make a rally even with no ball tracked; one-sided swinging does not', () => {
  const a = fakeAnalysis([])
  const swings = []
  for (let i = 0; i < 8; i++) swings.push({ t: 30 + i * 1.6, side: (i % 2 ? 'far' : 'near') as 'near' | 'far', overhead: false, speed: 5 })
  // A player bouncing the ball before serving: fast arm, same side, no exchange.
  for (let i = 0; i < 6; i++) swings.push({ t: 80 + i * 0.8, side: 'far' as const, overhead: false, speed: 5 })
  a.poseEvents = { swings, pickups: [], coverage: 1 }
  const segs = segmentRallies(a, DEFAULT_SEGMENT_PARAMS)
  assert.equal(segs.length, 1)
  assert.ok(segs[0].start < 30 && segs[0].end > 41, `${segs[0].start}-${segs[0].end}`)
})

test('pose: ball pickups damp activity outside exchanges', () => {
  const tracks: BallTrack[] = []
  for (let i = 0; i < 4; i++) tracks.push(flight(20 + i * 1.5, 1.0, i % 2 ? -1 : 1))
  const a = fakeAnalysis(tracks)
  const before = segmentRallies(a, DEFAULT_SEGMENT_PARAMS)
  a.poseEvents = { swings: [], pickups: [20.5, 22.0, 23.5, 25.0], coverage: 1 }
  const after = segmentRallies(a, DEFAULT_SEGMENT_PARAMS)
  assert.equal(before.length, 1)
  assert.equal(after.length, 0)
})

import { clipsForSegments, combineAnalyses, makeTimeline, naturalSort, toLocal } from './timeline.ts'

test('timeline: maps times across files and splits clips at boundaries', () => {
  const src = (path: string, d: number) => ({ ...fakeAnalysis([]).source, path, durationSec: d })
  const tl = makeTimeline([src('a', 600), src('b', 600), src('c', 300)])
  assert.equal(tl.duration, 1500)
  assert.deepEqual(toLocal(tl, 650), { index: 1, t: 50 })
  assert.deepEqual(toLocal(tl, 600), { index: 1, t: 0 })
  const clips = clipsForSegments(tl, [{ start: 590, end: 615 }, { start: 1300, end: 1310 }])
  assert.deepEqual(clips.map((c) => [c.source.path, c.start, c.end]), [['a', 590, 600], ['b', 0, 15], ['c', 100, 110]])
  assert.deepEqual(naturalSort(['DJI_0010.MP4', 'DJI_0002.MP4', 'DJI_0001.MP4']), ['DJI_0001.MP4', 'DJI_0002.MP4', 'DJI_0010.MP4'])
})

test('timeline: a rally that crosses a file boundary is still one rally', () => {
  // File A ends mid-rally at 60 s; file B continues it.
  const a = fakeAnalysis([], 60)
  const b = fakeAnalysis([], 60)
  for (let i = 0; i < 5; i++) a.tracks.push(flight(52 + i * 1.4, 1.1, i % 2 ? -1 : 1))
  for (let i = 0; i < 4; i++) b.tracks.push(flight(0.3 + i * 1.4, 1.1, i % 2 ? -1 : 1))
  const tl = makeTimeline([a.source, { ...b.source, path: 'b' }])
  const segs = segmentRallies(combineAnalyses(tl, [a, b]), DEFAULT_SEGMENT_PARAMS)
  assert.equal(segs.length, 1)
  assert.ok(segs[0].start < 52 && segs[0].end > 65, `${segs[0].start}-${segs[0].end}`)
  assert.equal(clipsForSegments(tl, segs).length, 2)
})

test('edges: clip starts just before the serve (not during ball bouncing) and ends after the last shot', () => {
  const a = fakeAnalysis([])
  const sw: { t: number; side: 'near' | 'far'; overhead: boolean; speed: number }[] = []
  // Server bounces the ball (same-side "swings") from 30 s, serves at 36 s, then a 4-shot exchange.
  for (let i = 0; i < 4; i++) sw.push({ t: 30 + i * 1.2, side: 'near', overhead: false, speed: 4 })
  sw.push({ t: 36, side: 'near', overhead: true, speed: 6 })
  for (let i = 1; i <= 4; i++) sw.push({ t: 36 + i * 1.6, side: i % 2 ? 'far' : 'near', overhead: false, speed: 5 })
  a.poseEvents = { swings: sw, pickups: [], coverage: 1 }
  a.audio = { hop: 0.01, onset: [], hits: [{ t: 36.05, s: 40 }] }
  const segs = segmentRallies(a, DEFAULT_SEGMENT_PARAMS)
  assert.equal(segs.length, 1)
  assert.ok(segs[0].start > 33.5 && segs[0].start < 35, `starts at the toss, not the bouncing (${segs[0].start})`)
  assert.ok(segs[0].end > 43 && segs[0].end < 45.5, `ends after the last shot lands (${segs[0].end})`)
})

test('edges: an overhead in the middle of an exchange is a smash, not a new start', () => {
  const a = fakeAnalysis([])
  const sw: { t: number; side: 'near' | 'far'; overhead: boolean; speed: number }[] = []
  for (let i = 0; i < 10; i++) sw.push({ t: 20 + i * 1.5, side: i % 2 ? 'far' : 'near', overhead: i === 7, speed: 5 })
  a.poseEvents = { swings: sw, pickups: [], coverage: 1 }
  a.audio = { hop: 0.01, onset: [], hits: [{ t: 30.5, s: 40 }] }
  const segs = segmentRallies(a, DEFAULT_SEGMENT_PARAMS)
  assert.equal(segs.length, 1)
  assert.ok(segs[0].start < 20, `rally kept from its first stroke (${segs[0].start})`)
})

import { concatPath, hardwareArgs } from './export.ts'

test('export: Windows paths are safe in the concat list; encoder flags per GPU family', () => {
  assert.equal(concatPath('C:\\Users\\me\\.out.mp4.parts\\part0001.mp4'), 'C:/Users/me/.out.mp4.parts/part0001.mp4')
  assert.equal(concatPath("/tmp/it's.mp4"), "/tmp/it'\\''s.mp4")
  const nv = hardwareArgs('hevc_nvenc', 'hevc', 8000, true)
  assert.ok(nv.includes('p010le') && nv.includes('p5'))
  const amf = hardwareArgs('hevc_amf', 'hevc', 8000, true)
  assert.ok(!amf.includes('p010le'), 'AMF stays 8-bit')
  const qsv = hardwareArgs('h264_qsv', 'h264', 8000, false)
  assert.deepEqual(qsv.slice(0, 2), ['-c:v', 'h264_qsv'])
  assert.ok(qsv.includes('nv12'))
})
