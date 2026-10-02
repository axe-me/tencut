import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Runs in an Electron utilityProcess so analysis never blocks the UI or main process.
          'analysis-host': resolve('src/main/analysis-host.ts'),
          // worker_threads entry used by the analysis host for parallel chunk decoding.
          'video-worker': resolve('src/core/video-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
    plugins: [react()],
  },
})
