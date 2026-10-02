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
    c.push(100 + f, 200 + f * 25, 300 + f * 2, 6) // fast: ball
    c.push(100 + f, 900 + f * 1, 500, 8) // slow: clothing
  }
  a.video.candidates = c
  const tracks = trackBalls(a.video)
  assert.equal(tracks.length, 1)
  assert.ok(tracks[0].points[0][1] < 250)
})

test('resolutions never upscale', () => {
  assert.deepEqual(allowedResolutions({ width: 1920, height: 1080 }), ['720p', 'source'])
  assert.deepEqual(allowedResolutions({ width: 3840, height: 2160 }), ['720p', '1080p', '1440p', 'source'])
  assert.deepEqual(targetSize({ width: 3840, height: 2160 }, '1080p'), { w: 1920, h: 1080 })
  assert.deepEqual(targetSize({ width: 1080, height: 1920 }, '720p'), { w: 720, h: 1280 })
})
