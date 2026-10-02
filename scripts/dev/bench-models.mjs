import ort from 'onnxruntime-node'
import { execSync } from 'node:child_process'
const M = process.argv[2]
const files = execSync(`find ${M} -name end2end.onnx`).toString().trim().split('\n')
for (const f of files) {
  const name = f.split('/').filter((x) => x.includes('_'))[0]
  for (const ep of ['cpu', 'coreml']) {
    try {
      const s = await ort.InferenceSession.create(f, { executionProviders: [ep], intraOpNumThreads: 2, graphOptimizationLevel: 'all' })
      const shape = name.startsWith('rtmo') ? [1, 3, 640, 640] : name.startsWith('yolox') ? [1, 3, 416, 416] : [1, 3, 256, 192]
      const x = new ort.Tensor('float32', new Float32Array(shape.reduce((a, b) => a * b)).fill(0.5), shape)
      let out = await s.run({ [s.inputNames[0]]: x })
      const t0 = performance.now(); const N = 20
      for (let i = 0; i < N; i++) out = await s.run({ [s.inputNames[0]]: x })
      const ms = (performance.now() - t0) / N
      console.log(name.slice(0, 40).padEnd(42), ep.padEnd(7), ms.toFixed(1) + 'ms', 'in', s.inputNames.join(','), JSON.stringify(shape), 'out', Object.entries(out).map(([k, v]) => k + JSON.stringify(v.dims)).join(' '))
    } catch (e) { console.log(name, ep, 'ERR', e.message.slice(0, 150)) }
  }
}
