import { useEffect, useState } from 'react'
import type { CourtCalibration } from '../../../core/types'
import type { Timeline } from '../../../core/timeline'
import type { ProjectState } from '../project'
import { basename, fmtBytes, fmtDuration } from '../util'
import { CourtPicker } from './CourtPicker'
import { OutputSettings } from './OutputSettings'

interface Props {
  timeline: Timeline
  project: ProjectState
  onStart: (p: ProjectState) => void
  /** New ordered list of files for this match. */
  onSources: (paths: string[]) => void
}

export function Setup({ timeline, project, onStart, onSources }: Props) {
  const sources = timeline.sources
  const source = sources[0]
  const paths = sources.map((s) => s.path)
  const move = (i: number, d: -1 | 1) => {
    const next = [...paths]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    onSources(next)
  }
  const mismatch = sources.some((s) => s.width !== source.width || s.height !== source.height)
  const [court, setCourt] = useState<CourtCalibration | null>(project.court)
  const [output, setOutput] = useState(project.output)
  const [skipCourt, setSkipCourt] = useState(false)
  const [usePose, setUsePose] = useState(project.usePose !== false)
  const [poseAvailable, setPoseAvailable] = useState(true)
  useEffect(() => {
    window.tencut.poseAvailable().then(setPoseAvailable)
  }, [])
  const pose = usePose && poseAvailable
  // Rough estimate on Apple Silicon for 4K: ~18x realtime without pose, ~10x with.
  const estMin = Math.max(1, Math.round(timeline.duration / (pose ? 10 : 18) / 60))

  return (
    <div className="setup">
      <section className="setup-main">
        <h2>1 · Mark your court</h2>
        <p className="dim">
          Neighbouring courts are often in the shot. Marking yours tells TenCut where to look, so other players' balls are ignored.
        </p>
        {skipCourt ? (
          <div className="empty-court">
            <p>Using the whole frame. Works when only your court is visible.</p>
            <button className="ghost" onClick={() => setSkipCourt(false)}>
              Mark the court instead
            </button>
          </div>
        ) : (
          <CourtPicker timeline={timeline} value={court} onChange={setCourt} />
        )}
      </section>
      <aside className="setup-side">
        <div className="card">
          <h3>{sources.length > 1 ? `Recordings · ${sources.length} files` : 'Recording'}</h3>
          {sources.length > 1 && (
            <ol className="file-list">
              {sources.map((s, i) => (
                <li key={s.path} title={s.path}>
                  <span className="fl-name">{basename(s.path)}</span>
                  <span className="dim mono">{fmtDuration(s.durationSec)}</span>
                  <button className="icon tiny" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                    ↑
                  </button>
                  <button className="icon tiny" disabled={i === sources.length - 1} onClick={() => move(i, 1)} title="Move down">
                    ↓
                  </button>
                  <button className="icon tiny" onClick={() => onSources(paths.filter((p) => p !== s.path))} title="Remove from this match">
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          )}
          {mismatch && <div className="hint warn">Files have different resolutions – exports are scaled to the first file's size.</div>}
          <button
            className="ghost small add-files"
            onClick={async () => {
              const more = (await window.tencut.openVideos()) ?? []
              if (more.length) onSources([...paths, ...more.filter((p) => !paths.includes(p))])
            }}
          >
            + Add recording…
          </button>
          <dl className="meta">
            <dt>Length</dt>
            <dd>{fmtDuration(timeline.duration)}</dd>
            <dt>Video</dt>
            <dd>
              {source.width}×{source.height} · {source.fps.toFixed(2).replace(/\.00$/, '')} fps · {source.videoCodec.toUpperCase()}
              {/10/.test(source.pixFmt) ? ' 10-bit' : ''}
            </dd>
            <dt>Size</dt>
            <dd>{fmtBytes(sources.reduce((t, s) => t + s.sizeBytes, 0))}</dd>
            <dt>Audio</dt>
            <dd>{source.hasAudio ? `${source.audioSampleRate / 1000} kHz` : 'none – detection uses video only'}</dd>
          </dl>
        </div>
        <div className="card">
          <h3>2 · Output</h3>
          <OutputSettings source={source} value={output} onChange={setOutput} />
        </div>
        <div className="card cta">
          <button
            className="primary large block"
            disabled={!skipCourt && !court}
            onClick={() => onStart({ ...project, court: skipCourt ? null : court, output, usePose })}
          >
            Find rallies
          </button>
          <label className="check pose-check" title="Follows both players' body movement to spot strokes, serves and ball pickups">
            <input type="checkbox" checked={pose} disabled={!poseAvailable} onChange={(e) => setUsePose(e.target.checked)} />
            Track players' strokes (pose model)
          </label>
          <div className="hint">
            {poseAvailable
              ? 'Keeps rallies going when the ball is hard to see, finds serves, and cuts ball pickups. About half the speed.'
              : 'Pose model files not found – detection uses ball and sound only.'}
          </div>
          <div className="hint center">
            {!skipCourt && !court ? 'Mark the 4 court points first' : `Takes about ${estMin} min · video is streamed, never fully loaded`}
          </div>
          {!skipCourt && (
            <button className="link" onClick={() => setSkipCourt(true)}>
              Skip – my court fills the frame
            </button>
          )}
        </div>
      </aside>
    </div>
  )
}
