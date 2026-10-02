import { useEffect, useState } from 'react'
import type { Progress, Segment, SourceInfo } from '../../../core/types'
import type { OutputSettings as Settings } from '../project'
import { fmtBytes, fmtDuration } from '../util'
import { OutputSettings } from './OutputSettings'

type State =
  | { name: 'settings' }
  | { name: 'running'; progress: Progress; outputPath: string }
  | { name: 'done'; outputPath: string; bytes: number; elapsedSec: number }
  | { name: 'error'; message: string }

interface Props {
  source: SourceInfo
  segments: Segment[]
  output: Settings
  onOutput: (o: Settings) => void
  onClose: () => void
}

export function ExportDialog({ source, segments, output, onOutput, onClose }: Props) {
  const [state, setState] = useState<State>({ name: 'settings' })
  const [estimate, setEstimate] = useState<number | null>(null)
  const clips = segments.map((s) => ({ source, start: Math.max(0, s.start), end: Math.min(source.durationSec, s.end) }))
  const total = clips.reduce((t, c) => t + c.end - c.start, 0)
  const ext = output.container

  useEffect(() => {
    window.tencut.estimateExport(clips, { ...output, outputPath: '' }).then(setEstimate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output, segments])

  useEffect(
    () =>
      window.tencut.onExportProgress((p) =>
        setState((s) => (s.name === 'running' ? { ...s, progress: p } : s)),
      ),
    [],
  )

  const start = async () => {
    const def = await window.tencut.defaultOutputName(source.path, ext)
    const outputPath = await window.tencut.saveOutput(def, ext)
    if (!outputPath) return
    if (outputPath === source.path) return setState({ name: 'error', message: 'Choose a different file name than the original recording.' })
    setState({ name: 'running', outputPath, progress: { phase: 'encode', fraction: 0, message: 'Starting…' } })
    try {
      const r = await window.tencut.exportClips(clips, { ...output, outputPath })
      setState({ name: 'done', ...r })
    } catch (e) {
      const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setState(/cancel/i.test(msg) ? { name: 'settings' } : { name: 'error', message: msg })
    }
  }

  return (
    <div className="modal-back" onClick={() => state.name !== 'running' && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export rallies</h2>
        <p className="dim">
          {segments.length} rallies · {fmtDuration(total)} of {fmtDuration(source.durationSec)}
          {estimate !== null && state.name === 'settings' && <> · up to ~{fmtBytes(estimate)}</>}
        </p>
        {state.name === 'settings' && (
          <>
            <OutputSettings source={source} value={output} onChange={onOutput} />
            <div className="modal-actions">
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" onClick={start}>
                Choose file & export…
              </button>
            </div>
          </>
        )}
        {state.name === 'running' && (
          <>
            <div className="progress">
              <div className="bar" style={{ width: `${(state.progress.fraction * 100).toFixed(1)}%` }} />
            </div>
            <div className="progress-meta">
              <span>{state.progress.message}</span>
              <span className="dim">{state.progress.etaSec !== undefined && `about ${fmtDuration(state.progress.etaSec)} left`}</span>
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => window.tencut.cancelExport()}>
                Cancel export
              </button>
            </div>
          </>
        )}
        {state.name === 'done' && (
          <>
            <div className="done">
              ✓ Saved <b>{state.outputPath.split(/[\\/]/).pop()}</b> · {fmtBytes(state.bytes)} · took {fmtDuration(state.elapsedSec)}
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => window.tencut.reveal(state.outputPath)}>
                Show in {window.tencut.platform === 'darwin' ? 'Finder' : 'folder'}
              </button>
              <button className="ghost" onClick={() => window.tencut.openPath(state.outputPath)}>
                Play
              </button>
              <button className="primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
        {state.name === 'error' && (
          <>
            <div className="banner error">{state.message}</div>
            <div className="modal-actions">
              <button className="ghost" onClick={onClose}>
                Close
              </button>
              <button className="primary" onClick={() => setState({ name: 'settings' })}>
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
