// Dev: run detector + pose on raw 1280x720 RGB frames, print boxes/keypoints as JSON for visual checking.
import { readFileSync } from 'node:fs'
import ort from 'onnxruntime-node'
import { PoseRunner } from '../../src/core/pose.ts'
const W = 1280, H = 720
const runner = await PoseRunner.create(ort, { detector: 'resources/models/yolox-tiny-humanart.onnx', pose: 'resources/models/rtmpose-t-body7.onnx' })
const out: any[] = []
for (const f of process.argv.slice(2)) {
  const rgb = new Uint8Array(readFileSync(f))
  let t = performance.now()
  const full = await runner.detect(rgb, W, H)
  const tFull = performance.now() - t
  // Far court band, upscaled: where the far player stands in this camera.
  t = performance.now()
  const far = await runner.detect(rgb, W, H, { x: 480, y: 160, w: 800, h: 300 })
  const tFar = performance.now() - t
  const boxes = [...full, ...far.filter((b) => !full.some((a) => Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) < 20 && Math.abs(a.y1 - b.y1) < 20))]
  const people = []
  t = performance.now()
  for (const b of boxes) people.push({ box: b, kps: Array.from(await runner.estimate(rgb, W, H, b)).map((v) => Math.round(v * 100) / 100) })
  const tPose = performance.now() - t
  out.push({ file: f, ms: { full: tFull, far: tFar, pose: tPose }, people })
}
console.log(JSON.stringify(out))
