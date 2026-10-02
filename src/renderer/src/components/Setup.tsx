import { useState } from 'react'
import type { CourtCalibration, SourceInfo } from '../../../core/types'
import type { ProjectState } from '../project'
import { fmtBytes, fmtDuration } from '../util'
import { CourtPicker } from './CourtPicker'
import { OutputSettings } from './OutputSettings'

export function Setup({ source, project, onStart }: { source: SourceInfo; project: ProjectState; onStart: (p: ProjectState) => void }) {
  const [court, setCourt] = useState<CourtCalibration | null>(project.court)
  const [output, setOutput] = useState(project.output)
  const [skipCourt, setSkipCourt] = useState(false)
  // Rough estimate: analysis runs ~15-20x realtime on Apple Silicon for 4K.
  const estMin = Math.max(1, Math.round(source.durationSec / 17 / 60))

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
          <CourtPicker source={source} value={court} onChange={setCourt} />
        )}
      </section>
      <aside className="setup-side">
        <div className="card">
          <h3>Recording</h3>
          <dl className="meta">
            <dt>Length</dt>
            <dd>{fmtDuration(source.durationSec)}</dd>
            <dt>Video</dt>
            <dd>
              {source.width}×{source.height} · {source.fps.toFixed(2).replace(/\.00$/, '')} fps · {source.videoCodec.toUpperCase()}
              {/10/.test(source.pixFmt) ? ' 10-bit' : ''}
            </dd>
            <dt>Size</dt>
            <dd>{fmtBytes(source.sizeBytes)}</dd>
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
            onClick={() => onStart({ ...project, court: skipCourt ? null : court, output })}
          >
            Find rallies
          </button>
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
