import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnalysisResult, SourceInfo } from '../../core/types'
import { newProject, type ProjectState } from './project'
import { Home } from './components/Home'
import { Setup } from './components/Setup'
import { Analyzing } from './components/Analyzing'
import { Review } from './components/Review'

type Screen =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'analyzing' }
  | { name: 'review'; analysis: AnalysisResult }

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [source, setSource] = useState<SourceInfo | null>(null)
  const [project, setProject] = useState<ProjectState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Persist project edits (debounced).
  const saveTimer = useRef<number>(0)
  useEffect(() => {
    if (!project) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => window.tencut.saveProject(project.sourcePath, project), 400)
  }, [project])

  const open = useCallback(async (paths: string[]) => {
    if (!paths.length) return
    setError(null)
    setBusy(true)
    try {
      const path = paths[0]
      const info = await window.tencut.probe(path)
      const saved = (await window.tencut.loadProject(path)) as ProjectState | null
      const p = saved?.version === 1 ? { ...saved, sourcePath: path } : newProject(info)
      setSource(info)
      setProject(p)
      if (paths.length > 1) setError('Joining several recordings into one match is planned for phase 2 – opened the first file only.')
      const cached = p.court !== undefined ? await window.tencut.cachedAnalysis(path, p.court) : null
      setScreen(cached && saved ? { name: 'review', analysis: cached } : { name: 'setup' })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  const startAnalysis = useCallback(async (p: ProjectState) => {
    if (!source) return
    setProject(p)
    setError(null)
    const cached = await window.tencut.cachedAnalysis(source.path, p.court)
    if (cached) return setScreen({ name: 'review', analysis: cached })
    setScreen({ name: 'analyzing' })
    try {
      const analysis = await window.tencut.analyze(source.path, p.court, source)
      setScreen({ name: 'review', analysis })
    } catch (e) {
      const msg = (e as Error).message
      if (!/cancel/i.test(msg)) setError(`Analysis failed: ${msg}`)
      setScreen({ name: 'setup' })
    }
  }, [source])

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">
          <span className="brand-mark">●</span> TenCut
        </span>
        {source && screen.name !== 'home' && (
          <span className="titlebar-file" title={source.path}>
            {source.path.split(/[\\/]/).pop()}
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
        {screen.name === 'setup' && source && project && <Setup source={source} project={project} onStart={startAnalysis} />}
        {screen.name === 'analyzing' && source && <Analyzing source={source} onCancel={() => window.tencut.cancelAnalysis()} />}
        {screen.name === 'review' && source && project && (
          <Review source={source} analysis={screen.analysis} project={project} onChange={setProject} onRecalibrate={() => setScreen({ name: 'setup' })} />
        )}
      </div>
    </div>
  )
}
