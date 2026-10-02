import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeEvidence, estimateShots, totalDuration } from '../../../core/segment'
import type { AnalysisResult, Segment, SegmentParams } from '../../../core/types'
import { toLocal, type Timeline as MatchTimeline } from '../../../core/timeline'
import { buildSegments, newId, setAllKept, upsertManual, type ProjectState } from '../project'
import { clamp, fmtDuration, fmtTime, plural } from '../util'
import { Timeline, type View } from './Timeline'
import { ExportDialog } from './ExportDialog'
import { LutView } from './LutView'
import { LutPicker } from './LutPicker'

interface Props {
  timeline: MatchTimeline
  analysis: AnalysisResult
  project: ProjectState
  onChange: (p: ProjectState) => void
  onRecalibrate: () => void
}

export function Review({ timeline, analysis, project, onChange, onRecalibrate }: Props) {
  const duration = timeline.duration
  const multi = timeline.sources.length > 1
  const evidence = useMemo(() => computeEvidence(analysis), [analysis])
  const segments = useMemo(() => buildSegments(analysis, project.params, project.manual, evidence), [analysis, project.params, project.manual, evidence])
  const kept = useMemo(() => segments.filter((s) => s.kept), [segments])
  const serveCount = segments.filter((s) => s.kind === 'serve').length
  const keptDur = totalDuration(segments)
  const shots = useMemo(() => new Map(segments.map((s) => [s.id, estimateShots(analysis, s.start, s.end)])), [segments, analysis])

  const video = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [previewKept, setPreviewKept] = useState(true)
  const [rate, setRate] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<View>({ start: 0, end: duration })
  const [inMark, setInMark] = useState<number | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [videoError, setVideoError] = useState<string | null>(null)
  const lutId = project.output.lutId ?? null

  const selected = segments.find((s) => s.id === selectedId) ?? null
  const setParams = (patch: Partial<SegmentParams>) => onChange({ ...project, params: { ...project.params, ...patch } })
  const setManual = (manual: Segment[]) => onChange({ ...project, manual })

  // One <video> element plays whichever file the playhead is in; all times here are match-timeline times.
  const [fileIdx, setFileIdx] = useState(0)
  const fileIdxRef = useRef(0)
  fileIdxRef.current = fileIdx
  const pending = useRef<{ t: number; play: boolean } | null>(null)
  const globalNow = () => timeline.offsets[fileIdxRef.current] + (video.current?.currentTime ?? 0)

  const seek = useCallback(
    (t: number, opts: { play?: boolean } = {}) => {
      const v = video.current
      const tt = clamp(t, 0, duration)
      const loc = toLocal(timeline, tt)
      if (loc.index !== fileIdxRef.current) {
        // Switch file; position (and resume) once the new file's metadata is loaded.
        pending.current = { t: loc.t, play: opts.play ?? (!!v && !v.paused) }
        fileIdxRef.current = loc.index
        setFileIdx(loc.index)
      } else if (v) {
        v.currentTime = loc.t
        if (opts.play) v.play()
      }
      setTime(tt)
    },
    [duration, timeline],
  )

  const onLoaded = () => {
    const v = video.current
    const p = pending.current
    if (!v || !p) return
    pending.current = null
    v.currentTime = p.t
    v.playbackRate = rate
    if (p.play) v.play()
  }

  // Keep the timeline playhead in sync, continue into the next file at the end of one, and in "kept only"
  // mode jump over removed parts.
  const previewRef = useRef(previewKept)
  previewRef.current = previewKept
  const keptRef = useRef(kept)
  keptRef.current = kept
  const seekRef = useRef(seek)
  seekRef.current = seek
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const v = video.current
      if (v && !pending.current) {
        let t = globalNow()
        const idx = fileIdxRef.current
        const fileEnd = idx < timeline.sources.length - 1 && v.duration > 0 && v.currentTime >= v.duration - 0.05
        if (!v.paused && previewRef.current) {
          const ks = keptRef.current
          const inside = ks.find((s) => t >= s.start - 0.05 && t < s.end)
          if (!inside) {
            const next = ks.find((s) => s.start > t)
            if (next) {
              seekRef.current(next.start, { play: true })
              t = next.start
            } else v.pause()
          } else if (fileEnd) seekRef.current(timeline.offsets[idx + 1], { play: true })
        } else if (fileEnd && !v.paused) seekRef.current(timeline.offsets[idx + 1], { play: true })
        setTime((prev) => (Math.abs(prev - t) > 0.02 ? t : prev))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [timeline]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate
  }, [rate])

  // Follow the playhead when it leaves the zoomed view.
  useEffect(() => {
    const span = view.end - view.start
    if (span >= duration - 1) return
    if (time < view.start || time > view.end) {
      const s = clamp(time - span * 0.1, 0, duration - span)
      setView({ start: s, end: s + span })
    }
  }, [time]) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    const v = video.current
    if (!v) return
    if (v.paused) {
      const now = globalNow()
      if (previewKept && !kept.some((s) => now >= s.start && now < s.end)) {
        const next = kept.find((s) => s.start > now) ?? kept[0]
        if (next) return seek(next.start, { play: true })
      }
      v.play()
    } else v.pause()
  }

  const jumpRally = (dir: 1 | -1) => {
    const list = segments
    if (!list.length) return
    const cur = time + (dir > 0 ? 0.05 : -0.5)
    const target = dir > 0 ? list.find((s) => s.start > cur) : [...list].reverse().find((s) => s.start < cur)
    if (target) {
      setSelectedId(target.id)
      seek(target.start)
      zoomTo(target)
    }
  }

  const zoomTo = (s: Segment) => {
    const span = view.end - view.start
    if (span < duration - 1 && s.start >= view.start && s.end <= view.end) return
    const want = Math.min(duration, Math.max(90, (s.end - s.start) * 4))
    const st = clamp((s.start + s.end) / 2 - want / 2, 0, duration - want)
    setView({ start: st, end: st + want })
  }

  const toggleKeep = (s: Segment) => setManual(upsertManual(project.manual, { ...s, kept: !s.kept }))
  const resize = (s: Segment, start: number, end: number) => setManual(upsertManual(project.manual, { ...s, start: round2(start), end: round2(end) }))
  const remove = (s: Segment) => {
    if (s.manual && project.manual.some((m) => m.id === s.id) && s.id.startsWith('m')) setManual(project.manual.filter((m) => m.id !== s.id))
    else setManual(upsertManual(project.manual, { ...s, kept: false }))
  }
  const resetSeg = (s: Segment) => setManual(project.manual.filter((m) => m.id !== s.id))
  const addSegment = (start: number, end: number) => {
    const seg: Segment = { id: newId(), start: round2(Math.min(start, end)), end: round2(Math.max(start, end)), score: 1, kept: true, manual: true }
    // A new manual segment replaces anything it overlaps.
    const manual = project.manual.filter((m) => !(m.start < seg.end && seg.start < m.end))
    setManual([...manual, seg])
    setSelectedId(seg.id)
  }
  const splitAt = (t: number) => {
    const s = segments.find((x) => t > x.start + 0.5 && t < x.end - 0.5)
    if (!s) return
    const a: Segment = { ...s, id: newId(), end: round2(t), manual: true }
    const b: Segment = { ...s, id: newId(), start: round2(t), manual: true }
    setManual([...project.manual.filter((m) => m.id !== s.id), a, b])
    setSelectedId(b.id)
  }

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showExport) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const k = e.key
      if (k === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (k === 'ArrowLeft') seek(time - (e.shiftKey ? 1 : 5))
      else if (k === 'ArrowRight') seek(time + (e.shiftKey ? 1 : 5))
      else if (k === 'ArrowUp' || k === '[') {
        e.preventDefault()
        jumpRally(-1)
      } else if (k === 'ArrowDown' || k === ']') {
        e.preventDefault()
        jumpRally(1)
      } else if ((k === 'k' || k === 'Enter') && selected) toggleKeep(selected)
      else if (k === 'i') setInMark(time)
      else if (k === 'o' && inMark !== null) {
        if (Math.abs(time - inMark) > 0.5) addSegment(inMark, time)
        setInMark(null)
      } else if (k === 'Escape') setInMark(null)
      else if (k === 's') splitAt(time)
      else if ((k === 'Backspace' || k === 'Delete') && selected) remove(selected)
      else if (k === 'p') setPreviewKept((x) => !x)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const current = segments.find((s) => time >= s.start && time < s.end)
  const sens = project.params.sensitivity

  return (
    <div className="review">
      <div className="review-top">
        <div className="player">
          <div className="video-wrap">
            <video
              ref={video}
              crossOrigin="anonymous"
              src={window.tencut.mediaUrl(timeline.sources[fileIdx].path)}
              onLoadedMetadata={onLoaded}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() => setVideoError('This video can’t be previewed here (codec not supported by the built-in player). Detection and export still work.')}
              onClick={togglePlay}
              preload="auto"
            />
            <LutView video={video} lutId={lutId} enabled />
            {videoError && <div className="video-error">{videoError}</div>}
            {multi && (
              <div className="file-tag" title={timeline.sources[fileIdx].path}>
                File {fileIdx + 1}/{timeline.sources.length} · {timeline.sources[fileIdx].path.split(/[\\/]/).pop()}
              </div>
            )}
            {current && (
              <div className={`rally-tag ${current.kept ? 'kept' : 'dropped'}`}>
                {current.kind === 'serve' ? 'Serve' : 'Rally'} {segments.indexOf(current) + 1} · {current.kept ? 'kept' : 'removed'}
              </div>
            )}
          </div>
          <div className="controls">
            <button className="icon" onClick={() => jumpRally(-1)} title="Previous rally (↑)">
              ⏮
            </button>
            <button className="icon play" onClick={togglePlay} title="Play / pause (space)">
              {playing ? '❚❚' : '▶'}
            </button>
            <button className="icon" onClick={() => jumpRally(1)} title="Next rally (↓)">
              ⏭
            </button>
            <span className="mono time">
              {fmtTime(time, true)} <span className="dim">/ {fmtTime(duration)}</span>
            </span>
            <span className="spacer" />
            <label className="inline-field" title="Colour LUT for the preview and export">
              LUT
              <LutPicker compact value={lutId} onChange={(id) => onChange({ ...project, output: { ...project.output, lutId: id } })} />
            </label>
            <label className="check" title="Skip removed parts while playing (P)">
              <input type="checkbox" checked={previewKept} onChange={(e) => setPreviewKept(e.target.checked)} />
              Play kept only
            </label>
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))} title="Playback speed">
              {[0.5, 1, 1.5, 2, 4].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </div>
        </div>
        <aside className="rally-list">
          <div className="rl-head">
            <label className="rl-all" title={kept.length === segments.length ? 'Untick all clips' : 'Tick all clips'}>
              <input
                type="checkbox"
                ref={(el) => {
                  if (el) el.indeterminate = kept.length > 0 && kept.length < segments.length
                }}
                checked={segments.length > 0 && kept.length === segments.length}
                disabled={!segments.length}
                onChange={(e) => setManual(setAllKept(analysis, project.params, project.manual, segments, e.target.checked))}
              />
              <b>
                {plural(segments.length, 'clip')}
                {serveCount > 0 && <span className="dim"> · {plural(serveCount, 'serve')}</span>}
              </b>
            </label>
            <span className="dim">
              {kept.length} kept · {fmtDuration(keptDur)}
            </span>
          </div>
          <div className="rl-body">
            {segments.map((s, i) => (
              <div
                key={s.id}
                className={`rl-row ${s.kept ? '' : 'off'} ${s.id === selectedId ? 'sel' : ''} ${current?.id === s.id ? 'cur' : ''}`}
                onClick={() => {
                  setSelectedId(s.id)
                  seek(s.start)
                  zoomTo(s)
                }}
              >
                <input type="checkbox" checked={s.kept} onClick={(e) => e.stopPropagation()} onChange={() => toggleKeep(s)} title="Keep this rally (K)" />
                <span className="rl-idx">{i + 1}</span>
                <span className="mono">{fmtTime(s.start)}</span>
                <span className="rl-dur">{(s.end - s.start).toFixed(0)}s</span>
                <span className="rl-shots" title={s.kind === 'serve' ? 'Serve with no rally after it (usually a fault)' : 'Estimated shots'}>
                  {s.kind === 'serve' ? <span className="serve-tag">serve</span> : `${shots.get(s.id)} shots`}
                </span>
                <span className="rl-conf" title={`Confidence ${(s.score * 100).toFixed(0)}%`}>
                  <span style={{ width: `${s.score * 100}%` }} />
                </span>
                {s.manual && (
                  <button className="link tiny" title="Undo my edits to this rally" onClick={(e) => (e.stopPropagation(), resetSeg(s))}>
                    ↺
                  </button>
                )}
              </div>
            ))}
            {!segments.length && <div className="dim pad">No rallies found. Try raising the sensitivity, or re-mark the court.</div>}
          </div>
        </aside>
      </div>

      <Timeline
        duration={duration}
        segments={segments}
        evidence={evidence}
        time={time}
        selectedId={selectedId}
        view={view}
        inMark={inMark}
        boundaries={timeline.offsets.slice(1)}
        onView={setView}
        onSeek={seek}
        onSelect={setSelectedId}
        onResize={resize}
      />

      <div className="review-bottom">
        <div className="tl-tools">
          <button className="ghost small" onClick={() => setView({ start: 0, end: duration })}>
            Fit
          </button>
          <button className="ghost small" onClick={() => (inMark === null ? setInMark(time) : (Math.abs(time - inMark) > 0.5 && addSegment(inMark, time), setInMark(null)))}>
            {inMark === null ? 'Mark in (I)' : 'Mark out (O)'}
          </button>
          <button className="ghost small" onClick={() => splitAt(time)} disabled={!segments.some((s) => time > s.start + 0.5 && time < s.end - 0.5)}>
            Split (S)
          </button>
          {selected && (
            <button className="ghost small" onClick={() => toggleKeep(selected)}>
              {selected.kept ? 'Remove rally (K)' : 'Keep rally (K)'}
            </button>
          )}
          <span className="dim small kbd-hint">Space play · ↑↓ rallies · ←→ 5s · scroll to zoom · drag rally edges to trim</span>
        </div>
        <div className="tuning">
          <div className="field inline">
            <label title="How eagerly ball activity counts as a rally">Detection</label>
            <span className="dim small">strict</span>
            <input type="range" min={0} max={1} step={0.05} value={sens} onChange={(e) => setParams({ sensitivity: Number(e.target.value) })} />
            <span className="dim small">loose</span>
          </div>
          <div className="field inline">
            <label title="Extra time before the serve / first stroke (the toss is always included)">Extra before</label>
            <NumberInput value={project.params.padBefore} min={0} max={10} step={0.5} onChange={(v) => setParams({ padBefore: v })} suffix="s" />
            <label title="Extra time after the last shot has landed">Extra after</label>
            <NumberInput value={project.params.padAfter} min={0} max={10} step={0.5} onChange={(v) => setParams({ padAfter: v })} suffix="s" />
            <label title="Join rallies separated by less than this">Join gaps &lt;</label>
            <NumberInput value={project.params.mergeGap} min={0} max={15} step={0.5} onChange={(v) => setParams({ mergeGap: v })} suffix="s" />
          </div>
          <span className="spacer" />
          <div className="summary">
            <b>{fmtDuration(keptDur)}</b> <span className="dim">of {fmtDuration(duration)} · {((keptDur / duration) * 100).toFixed(0)}% kept</span>
          </div>
          <button className="ghost" onClick={onRecalibrate}>
            Re-mark court
          </button>
          <button className="primary" disabled={!kept.length} onClick={() => setShowExport(true)}>
            Export {plural(kept.length, 'rally', 'rallies')}…
          </button>
        </div>
      </div>
      {showExport && (
        <ExportDialog
          timeline={timeline}
          segments={kept}
          output={project.output}
          onOutput={(output) => onChange({ ...project, output })}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}

function NumberInput({ value, onChange, min, max, step, suffix }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number; suffix?: string }) {
  return (
    <span className="num">
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(clamp(Number(e.target.value) || 0, min, max))} />
      {suffix}
    </span>
  )
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
