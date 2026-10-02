import { useEffect, useRef, useState } from 'react'
import type { Progress, SourceInfo } from '../../../core/types'
import { fmtDuration } from '../util'

export function Analyzing({ source, onCancel }: { source: SourceInfo; onCancel: () => void }) {
  const [p, setP] = useState<Progress>({ phase: 'analyze', fraction: 0, message: 'Starting…' })
  const started = useRef(Date.now())
  const [, tick] = useState(0)
  useEffect(() => window.tencut.onAnalysisProgress(setP), [])
  useEffect(() => {
    const id = window.setInterval(() => tick((x) => x + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsed = (Date.now() - started.current) / 1000
  const speed = elapsed > 3 ? (p.fraction * source.durationSec) / elapsed : 0
  return (
    <div className="center-screen">
      <div className="card progress-card">
        <h2>Finding rallies…</h2>
        <div className="progress">
          <div className="bar" style={{ width: `${(p.fraction * 100).toFixed(1)}%` }} />
        </div>
        <div className="progress-meta">
          <span>{(p.fraction * 100).toFixed(0)}%</span>
          <span className="dim">
            {elapsed > 3 && `${fmtDuration(elapsed)} elapsed`}
            {p.etaSec !== undefined && ` · about ${fmtDuration(p.etaSec)} left`}
            {speed > 0 && ` · ${speed.toFixed(0)}× realtime`}
          </span>
        </div>
        <p className="dim small">
          The video is decoded in parallel chunks with hardware acceleration, downscaled and cropped to your court, and only a few frames are in
          memory at any moment. Racket hits are picked out of the audio track at the same time.
        </p>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
