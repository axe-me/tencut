import { useCallback, useEffect, useRef, useState } from 'react'
import type { Evidence } from '../../../core/segment'
import { GRID_HZ } from '../../../core/segment'
import type { Segment } from '../../../core/types'
import { clamp, fmtTime } from '../util'

export interface View {
  start: number
  end: number
}

interface Props {
  duration: number
  segments: Segment[]
  evidence: Evidence
  time: number
  selectedId: string | null
  view: View
  inMark: number | null
  onView: (v: View) => void
  onSeek: (t: number) => void
  onSelect: (id: string | null) => void
  onResize: (seg: Segment, start: number, end: number) => void
}

const OVERVIEW_H = 22
const RULER_H = 20
const ACT_H = 46
const SEG_H = 34
const PAD = 6
const HEIGHT = OVERVIEW_H + PAD + RULER_H + ACT_H + SEG_H + PAD

const C = {
  bg: '#14171d',
  lane: '#191d24',
  grid: '#262b35',
  text: '#8a93a6',
  act: 'rgba(90, 160, 255, 0.55)',
  actLine: 'rgba(120, 180, 255, 0.9)',
  hit: 'rgba(255, 200, 90, 0.75)',
  kept: '#2fbf71',
  keptFill: 'rgba(47, 191, 113, 0.28)',
  drop: '#5a6272',
  dropFill: 'rgba(90, 98, 114, 0.18)',
  sel: '#ffffff',
  play: '#ff5a5a',
  view: 'rgba(255,255,255,0.12)',
  mark: '#ffcc33',
}

export function Timeline(p: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const drag = useRef<null | { kind: 'seek' } | { kind: 'edge'; seg: Segment; edge: 'start' | 'end'; start: number; end: number } | { kind: 'overview' }>(null)
  const [hoverCursor, setHoverCursor] = useState('default')

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    if (wrap.current) ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const { view, duration } = p
  const span = Math.max(0.5, view.end - view.start)
  const xOf = useCallback((t: number) => ((t - view.start) / span) * width, [view.start, span, width])
  const tOf = useCallback((x: number) => view.start + (x / width) * span, [view.start, span, width])

  // ---- draw
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = width * dpr
    cv.height = HEIGHT * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = C.bg
    g.fillRect(0, 0, width, HEIGHT)

    // Overview: whole recording, segments + current view window.
    const ox = (t: number) => (t / duration) * width
    g.fillStyle = C.lane
    g.fillRect(0, 0, width, OVERVIEW_H)
    for (const s of p.segments) {
      g.fillStyle = s.kept ? C.kept : C.drop
      g.fillRect(ox(s.start), 5, Math.max(1, ox(s.end) - ox(s.start)), OVERVIEW_H - 10)
    }
    g.fillStyle = C.view
    g.fillRect(ox(view.start), 0, Math.max(2, ox(view.end) - ox(view.start)), OVERVIEW_H)
    g.strokeStyle = 'rgba(255,255,255,0.35)'
    g.strokeRect(ox(view.start) + 0.5, 0.5, Math.max(2, ox(view.end) - ox(view.start)) - 1, OVERVIEW_H - 1)
    g.fillStyle = C.play
    g.fillRect(ox(p.time) - 1, 0, 2, OVERVIEW_H)

    const top = OVERVIEW_H + PAD
    // Ruler
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
    const minor = steps.find((s) => (s / span) * width > 60) ?? 3600
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.textBaseline = 'middle'
    for (let t = Math.ceil(view.start / minor) * minor; t <= view.end; t += minor) {
      const x = Math.round(xOf(t)) + 0.5
      g.strokeStyle = C.grid
      g.beginPath()
      g.moveTo(x, top + RULER_H - 6)
      g.lineTo(x, HEIGHT - PAD)
      g.stroke()
      g.fillStyle = C.text
      g.fillText(fmtTime(t), x + 4, top + RULER_H / 2)
    }

    // Activity curve
    const at = top + RULER_H
    g.fillStyle = C.lane
    g.fillRect(0, at, width, ACT_H)
    const act = p.evidence.activity
    g.beginPath()
    g.moveTo(0, at + ACT_H)
    for (let x = 0; x <= width; x += 2) {
      const t0 = tOf(x)
      const t1 = tOf(x + 2)
      let m = 0
      for (let i = Math.max(0, Math.floor(t0 * GRID_HZ)); i <= Math.min(act.length - 1, Math.ceil(t1 * GRID_HZ)); i++) m = Math.max(m, act[i])
      g.lineTo(x, at + ACT_H - m * (ACT_H - 4))
    }
    g.lineTo(width, at + ACT_H)
    g.closePath()
    g.fillStyle = C.act
    g.fill()
    // Audio hits as ticks (only when zoomed in enough to be meaningful)
    if (span < 900) {
      const hits = p.evidence.hits
      g.fillStyle = C.hit
      for (let i = Math.max(0, Math.floor(view.start * GRID_HZ)); i < Math.min(hits.length, Math.ceil(view.end * GRID_HZ)); i++) {
        if (hits[i] > 0) g.fillRect(xOf(i / GRID_HZ) - 0.5, at + 2, 1, 4 + hits[i] * 8)
      }
    }

    // Segments
    const st = at + ACT_H + 4
    for (const s of p.segments) {
      if (s.end < view.start || s.start > view.end) continue
      const x0 = xOf(s.start)
      const x1 = xOf(s.end)
      const sel = s.id === p.selectedId
      g.fillStyle = s.kept ? C.keptFill : C.dropFill
      g.fillRect(x0, at, x1 - x0, ACT_H)
      g.fillStyle = s.kept ? C.kept : C.drop
      roundRect(g, x0, st, Math.max(2, x1 - x0), SEG_H - 8, 4)
      g.fill()
      if (!s.kept) {
        g.strokeStyle = 'rgba(255,255,255,0.15)'
        g.save()
        g.beginPath()
        g.rect(x0, st, x1 - x0, SEG_H - 8)
        g.clip()
        for (let x = x0 - SEG_H; x < x1; x += 7) {
          g.beginPath()
          g.moveTo(x, st + SEG_H)
          g.lineTo(x + SEG_H, st - 8)
          g.stroke()
        }
        g.restore()
      }
      if (sel) {
        g.strokeStyle = C.sel
        g.lineWidth = 2
        roundRect(g, x0, st, Math.max(2, x1 - x0), SEG_H - 8, 4)
        g.stroke()
        g.lineWidth = 1
        // handles
        g.fillStyle = C.sel
        g.fillRect(x0 - 2, st + 4, 4, SEG_H - 16)
        g.fillRect(x1 - 2, st + 4, 4, SEG_H - 16)
      }
      if (x1 - x0 > 46) {
        g.fillStyle = s.kept ? '#06240f' : '#c9ced8'
        g.font = '11px -apple-system, system-ui, sans-serif'
        g.fillText(`${(s.end - s.start).toFixed(0)}s${s.manual ? ' ✎' : ''}`, x0 + 6, st + (SEG_H - 8) / 2)
      }
    }

    // In-mark
    if (p.inMark !== null) {
      const x = xOf(p.inMark)
      g.fillStyle = C.mark
      g.fillRect(x - 1, top, 2, HEIGHT - top - PAD)
      g.fillText('IN', x + 4, top + 8)
    }
    // Playhead
    const px = xOf(p.time)
    g.fillStyle = C.play
    g.fillRect(px - 1, top, 2, HEIGHT - top - PAD)
    g.beginPath()
    g.moveTo(px - 6, top)
    g.lineTo(px + 6, top)
    g.lineTo(px, top + 8)
    g.fill()
  }, [width, p.segments, p.evidence, p.time, p.selectedId, view, duration, xOf, tOf, span, p.inMark])

  // ---- interaction
  const hitTest = (x: number, y: number) => {
    const top = OVERVIEW_H + PAD
    if (y < OVERVIEW_H) return { zone: 'overview' as const }
    if (y < top) return { zone: 'none' as const }
    // Edge handles have priority (selected segment first).
    const ordered = [...p.segments].sort((a, b) => (a.id === p.selectedId ? -1 : b.id === p.selectedId ? 1 : 0))
    for (const s of ordered) {
      const x0 = xOf(s.start)
      const x1 = xOf(s.end)
      if (Math.abs(x - x0) < 6) return { zone: 'edge' as const, seg: s, edge: 'start' as const }
      if (Math.abs(x - x1) < 6) return { zone: 'edge' as const, seg: s, edge: 'end' as const }
    }
    const t = tOf(x)
    const seg = p.segments.find((s) => t >= s.start && t <= s.end)
    return { zone: 'track' as const, seg }
  }

  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onDown = (e: React.PointerEvent) => {
    const { x, y } = local(e)
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const h = hitTest(x, y)
    if (h.zone === 'overview') {
      drag.current = { kind: 'overview' }
      centerViewAt((x / width) * duration)
    } else if (h.zone === 'edge') {
      p.onSelect(h.seg.id)
      drag.current = { kind: 'edge', seg: h.seg, edge: h.edge, start: h.seg.start, end: h.seg.end }
    } else if (h.zone === 'track') {
      p.onSelect(h.seg?.id ?? null)
      drag.current = { kind: 'seek' }
      p.onSeek(clamp(tOf(x), 0, duration))
    }
  }

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = local(e)
    const d = drag.current
    if (!d) {
      const h = hitTest(x, y)
      setHoverCursor(h.zone === 'edge' ? 'ew-resize' : h.zone === 'overview' ? 'grab' : 'pointer')
      return
    }
    if (d.kind === 'overview') centerViewAt(clamp((x / width) * duration, 0, duration))
    else if (d.kind === 'seek') p.onSeek(clamp(tOf(x), 0, duration))
    else if (d.kind === 'edge') {
      const t = clamp(tOf(x), 0, duration)
      if (d.edge === 'start') d.start = Math.min(t, d.end - 0.5)
      else d.end = Math.max(t, d.start + 0.5)
      p.onSeek(d.edge === 'start' ? d.start : d.end)
      // Live preview of the drag without committing to the project yet.
      p.onResize({ ...d.seg, start: d.start, end: d.end }, d.start, d.end)
    }
  }

  const onUp = () => {
    drag.current = null
  }

  const centerViewAt = (t: number) => {
    const half = span / 2
    let s = t - half
    s = clamp(s, 0, Math.max(0, duration - span))
    p.onView({ start: s, end: s + span })
  }

  // Wheel: vertical = zoom around cursor, horizontal = pan. Native listener so we can preventDefault.
  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = cv.getBoundingClientRect()
      const x = e.clientX - r.left
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dt = (e.deltaX / width) * span
        const s = clamp(view.start + dt, 0, Math.max(0, duration - span))
        p.onView({ start: s, end: s + span })
      } else {
        const f = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))
        const ns = clamp(span * f, 5, duration)
        const anchor = view.start + (x / width) * span
        let s = anchor - (x / width) * ns
        s = clamp(s, 0, Math.max(0, duration - ns))
        p.onView({ start: s, end: s + ns })
      }
    }
    cv.addEventListener('wheel', onWheel, { passive: false })
    return () => cv.removeEventListener('wheel', onWheel)
  }, [view, span, width, duration, p])

  return (
    <div className="timeline" ref={wrap}>
      <canvas
        ref={canvas}
        style={{ width: '100%', height: HEIGHT, cursor: hoverCursor }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </div>
  )
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  g.beginPath()
  g.moveTo(x + rr, y)
  g.arcTo(x + w, y, x + w, y + h, rr)
  g.arcTo(x + w, y + h, x, y + h, rr)
  g.arcTo(x, y + h, x, y, rr)
  g.arcTo(x, y, x + w, y, rr)
  g.closePath()
}
