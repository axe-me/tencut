import { useEffect, useMemo, useRef, useState } from 'react'
import { apply, courtToImage, roiPolygon, COURT_L, COURT_W } from '../../../core/court'
import type { CourtCalibration, Point } from '../../../core/types'
import { toLocal, type Timeline } from '../../../core/timeline'
import { fmtTime } from '../util'

const PROMPTS: Record<CourtCalibration['mode'], string[]> = {
  full: ['near baseline – left corner', 'near baseline – right corner', 'far baseline – right corner', 'far baseline – left corner'],
  half: ['near baseline – left corner', 'near baseline – right corner', 'where the net meets the right sideline', 'where the net meets the left sideline'],
}

/** Court markings in metres (doubles court), for drawing the fitted overlay. */
const LINES: [number, number, number, number][] = (() => {
  const s = 1.372 // doubles alley width; service lines are 6.40 m from the net
  const L = COURT_L
  const W = COURT_W
  return [
    [0, 0, W, 0],
    [0, L, W, L],
    [0, 0, 0, L],
    [W, 0, W, L],
    [s, 0, s, L],
    [W - s, 0, W - s, L],
    [s, L / 2 - 6.4, W - s, L / 2 - 6.4],
    [s, L / 2 + 6.4, W - s, L / 2 + 6.4],
    [W / 2, L / 2 - 6.4, W / 2, L / 2 + 6.4],
    [0, L / 2, W, L / 2],
    [W / 2, 0, W / 2, 0.3],
    [W / 2, L, W / 2, L - 0.3],
  ]
})()

export function CourtPicker({
  timeline,
  value,
  onChange,
  lutId,
}: {
  timeline: Timeline
  value: CourtCalibration | null
  onChange: (c: CourtCalibration | null) => void
  lutId?: string | null
}) {
  const source = timeline.sources[0]
  const [mode, setMode] = useState<CourtCalibration['mode']>(value?.mode ?? 'full')
  const [pts, setPts] = useState<Point[]>(value?.corners ?? [])
  const [t, setT] = useState(Math.min(60, timeline.duration / 3))
  const [img, setImg] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [drag, setDrag] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const W = source.width
  const H = source.height

  // Load the frame at time t (debounced while scrubbing).
  useEffect(() => {
    let alive = true
    setLoading(true)
    const id = window.setTimeout(async () => {
      try {
        const loc = toLocal(timeline, t)
        const url = await window.tencut.frame(timeline.sources[loc.index].path, loc.t, 1600, lutId)
        if (alive) setImg(url)
      } finally {
        if (alive) setLoading(false)
      }
    }, 150)
    return () => {
      alive = false
      window.clearTimeout(id)
    }
  }, [timeline, t, lutId])

  // Report complete calibrations upward.
  useEffect(() => {
    if (pts.length === 4) onChange({ mode, corners: pts as CourtCalibration['corners'] })
    else onChange(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, mode])

  const overlay = useMemo(() => {
    if (pts.length !== 4) return null
    try {
      const cal: CourtCalibration = { mode, corners: pts as CourtCalibration['corners'] }
      const Hm = courtToImage(cal, W, H)
      const lines = LINES.map(([x0, y0, x1, y1]) => [apply(Hm, { x: x0, y: y0 }), apply(Hm, { x: x1, y: y1 })])
      const roi = roiPolygon(cal, W, H)
      return { lines, roi }
    } catch {
      return null
    }
  }, [pts, mode, W, H])

  const toNorm = (e: React.PointerEvent): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }

  const r = Math.max(W, H) / 160

  return (
    <div className="court-picker">
      <div className="cp-toolbar">
        <div className="seg">
          <button className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')} title="Both baselines are visible">
            Whole court visible
          </button>
          <button className={mode === 'half' ? 'on' : ''} onClick={() => setMode('half')} title="Low camera: use the net instead of the far baseline">
            Far baseline hard to see
          </button>
        </div>
        <span className="spacer" />
        <button className="ghost small" onClick={() => setPts([])} disabled={!pts.length}>
          Reset points
        </button>
      </div>
      <div className="cp-instruction">
        {pts.length < 4 ? (
          <>
            <span className="badge">{pts.length + 1}/4</span> Click the <b>{PROMPTS[mode][pts.length]}</b>
            <span className="dim"> · pick the court you played on; drag points to fine-tune</span>
          </>
        ) : (
          <>
            <span className="badge ok">✓</span> Court marked. Check that the drawn lines sit on the real lines; drag any point to adjust.
            <span className="dim"> The shaded area is where ball and players are tracked.</span>
          </>
        )}
      </div>
      <div className="cp-stage" style={{ aspectRatio: `${W} / ${H}` }}>
        {img && <img src={img} draggable={false} alt="" />}
        {loading && <div className="cp-loading">Loading frame…</div>}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onPointerDown={(e) => {
            if (drag !== null || pts.length >= 4) return
            setPts([...pts, toNorm(e)])
          }}
          onPointerMove={(e) => {
            if (drag === null) return
            const p = toNorm(e)
            setPts(pts.map((q, i) => (i === drag ? p : q)))
          }}
          onPointerUp={() => setDrag(null)}
          onPointerLeave={() => setDrag(null)}
        >
          {overlay && (
            <>
              <polygon points={overlay.roi.map((p) => `${p.x},${p.y}`).join(' ')} className="cp-roi" />
              {overlay.lines.map(([a, b], i) => (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={i === 9 ? 'cp-net' : 'cp-line'} />
              ))}
            </>
          )}
          {pts.length > 1 && <polyline points={pts.map((p) => `${p.x * W},${p.y * H}`).join(' ') + (pts.length === 4 ? ` ${pts[0].x * W},${pts[0].y * H}` : '')} className="cp-edge" />}
          {pts.map((p, i) => (
            <g key={i}>
              <circle
                cx={p.x * W}
                cy={p.y * H}
                r={r}
                className="cp-pt"
                onPointerDown={(e) => {
                  e.stopPropagation()
                  ;(e.target as Element).setPointerCapture?.(e.pointerId)
                  setDrag(i)
                }}
              />
              <text x={p.x * W + r * 1.4} y={p.y * H - r * 1.2} className="cp-label" style={{ fontSize: r * 2.2 }}>
                {i + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="cp-scrub">
        <span className="dim">Frame</span>
        <input type="range" min={0} max={Math.max(1, timeline.duration - 1)} step={1} value={t} onChange={(e) => setT(Number(e.target.value))} />
        <span className="mono">{fmtTime(t)}</span>
        {timeline.sources.length > 1 && <span className="dim small">file {toLocal(timeline, t).index + 1}</span>}
      </div>
    </div>
  )
}
