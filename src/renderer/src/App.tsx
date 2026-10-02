import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisResult, SourceInfo } from '../../core/types'
import { combineAnalyses, makeTimeline, naturalSort } from '../../core/timeline'
import { migrateProject, newProject, type ProjectState } from './project'
import { Home } from './components/Home'
import { Setup } from './components/Setup'
import { Analyzing } from './components/Analyzing'
import { Review } from './components/Review'
import logo from './assets/logo.svg'

type Screen =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'analyzing' }
  | { name: 'review'; analysis: AnalysisResult }

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [project, setProject] = useState<ProjectState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timeline = useMemo(() => makeTimeline(sources), [sources])

  // Persist project edits (debounced), keyed by the match's list of files.
  const saveTimer = useRef<number>(0)
  useEffect(() => {
    if (!project) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => window.tencut.saveProject(project.sourcePaths, project), 400)
  }, [project])

  const load = useCallback(async (paths: string[]): Promise<{ infos: SourceInfo[]; project: ProjectState; saved: boolean }> => {
    const infos = await Promise.all(paths.map((p) => window.tencut.probe(p)))
    const saved = (await window.tencut.loadProject(paths)) as ProjectState | null
    // New matches – and older projects saved before LUT support – start with the last LUT you used
    // (log footage usually comes from the same camera). An explicit "None" (null) is kept.
    const defaultLut = (await window.tencut.luts.list()).defaultId
    const p =
      saved?.version === 1
        ? migrateProject({ ...saved, sourcePaths: paths, output: { ...saved.output, lutId: saved.output.lutId === undefined ? defaultLut : saved.output.lutId } })
        : newProject(infos, defaultLut)
    return { infos, project: p, saved: !!saved }
  }, [])

  const cachedCombined = async (paths: string[], infos: SourceInfo[], p: ProjectState, lutId = p.analysisLutId ?? null) => {
    const parts = await window.tencut.cachedAnalysis(paths, { court: p.court, pose: p.usePose !== false, lutId })
    return parts.every((x): x is AnalysisResult => !!x) ? combineAnalyses(makeTimeline(infos), parts) : null
  }

  const open = useCallback(
    async (picked: string[]) => {
      if (!picked.length) return
      setError(null)
      setBusy(true)
      try {
        const paths = naturalSort([...new Set(picked)])
        const { infos, project: p, saved } = await load(paths)
        setSources(infos)
        setProject(p)
        const cached = saved && p.court !== undefined ? await cachedCombined(paths, infos, p) : null
        setScreen(cached ? { name: 'review', analysis: cached } : { name: 'setup' })
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  /** Setup changed the list of files (added, removed, reordered): keep the user's settings. */
  const changeSources = useCallback(
    async (paths: string[]) => {
      if (!project || !paths.length) return
      try {
        const infos = await Promise.all(paths.map((p) => window.tencut.probe(p)))
        setSources(infos)
        setProject({ ...project, sourcePaths: paths })
      } catch (e) {
        setError((e as Error).message)
      }
    },
    [project],
  )

  const startAnalysis = useCallback(
    async (p: ProjectState) => {
      if (!sources.length) return
      // Analyse with the chosen output LUT: on log footage detection works better on graded colours.
      const lutId = p.output.lutId ?? null
      p = { ...p, analysisLutId: lutId }
      setProject(p)
      setError(null)
      const usePose = p.usePose !== false
      const paths = sources.map((s) => s.path)
      const cached = await cachedCombined(paths, sources, p, lutId)
      if (cached) return setScreen({ name: 'review', analysis: cached })
      setScreen({ name: 'analyzing' })
      try {
        const parts = await window.tencut.analyze(paths, { court: p.court, pose: usePose, lutId }, sources)
        setScreen({ name: 'review', analysis: combineAnalyses(makeTimeline(sources), parts) })
      } catch (e) {
        const msg = (e as Error).message
        if (!/cancel/i.test(msg)) setError(`Analysis failed: ${msg}`)
        setScreen({ name: 'setup' })
      }
    },
    [sources],
  )

  const title = sources.length > 1 ? `${sources[0].path.split(/[\\/]/).pop()} + ${sources.length - 1} more` : sources[0]?.path.split(/[\\/]/).pop()

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">
          <img className="brand-logo" src={logo} alt="" /> TenCut
        </span>
        {sources.length > 0 && screen.name !== 'home' && (
          <span className="titlebar-file" title={sources.map((s) => s.path).join('\n')}>
            {title}
          </span>
        )}
        <span className="spacer" />
        {screen.name !== 'home' && (
          <button className="ghost small" onClick={() => setScreen({ name: 'home' })}>
            Open another…
          </button>
        )}
      </div>
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error} <span className="dim">(click to dismiss)</span>
        </div>
      )}
      <div className="content">
        {screen.name === 'home' && <Home onOpen={open} busy={busy} />}
        {screen.name === 'setup' && project && sources.length > 0 && (
          <Setup timeline={timeline} project={project} onStart={startAnalysis} onSources={changeSources} />
        )}
        {screen.name === 'analyzing' && sources.length > 0 && <Analyzing duration={timeline.duration} onCancel={() => window.tencut.cancelAnalysis()} />}
        {screen.name === 'review' && project && sources.length > 0 && (
          <Review
            timeline={timeline}
            analysis={screen.analysis}
            project={project}
            onChange={setProject}
            onRecalibrate={() => setScreen({ name: 'setup' })}
          />
        )}
      </div>
    </div>
  )
}
