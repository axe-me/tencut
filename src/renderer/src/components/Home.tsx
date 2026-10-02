import { useState } from 'react'

export function Home({ onOpen, busy }: { onOpen: (paths: string[]) => void; busy: boolean }) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={`home ${over ? 'dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const paths = [...e.dataTransfer.files].map((f) => window.tencut.pathForFile(f)).filter(Boolean)
        onOpen(paths)
      }}
    >
      <div className="home-card">
        <div className="home-icon">🎾</div>
        <h1>Cut a match down to the rallies</h1>
        <p className="dim">
          TenCut finds every point in a long tennis recording and removes the dead time – ball collection, walking back, changeovers. Everything runs
          on this computer; nothing is uploaded.
        </p>
        <button className="primary large" disabled={busy} onClick={async () => onOpen((await window.tencut.openVideos()) ?? [])}>
          {busy ? 'Opening…' : 'Open match recording…'}
        </button>
        <p className="hint">or drop a video file here · MP4, MOV, MKV · any length, up to 4K</p>
        <ol className="steps">
          <li>
            <b>Mark the court</b> you played on (four clicks) and pick the output format.
          </li>
          <li>
            <b>Analyze</b> – ball flights and racket sounds are detected in a streaming pass.
          </li>
          <li>
            <b>Review</b> the detected rallies, tweak, and <b>export</b>.
          </li>
        </ol>
      </div>
    </div>
  )
}
