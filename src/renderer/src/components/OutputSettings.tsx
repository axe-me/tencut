import { allowedResolutions, RES_LABEL, targetSize } from '../../../core/resolutions'
import type { OutputCodec, OutputContainer, SourceInfo } from '../../../core/types'
import type { OutputSettings as Settings } from '../project'
import { LutPicker } from './LutPicker'

const CODECS: { id: OutputCodec; label: string; hint: string }[] = [
  { id: 'h264', label: 'H.264', hint: 'Plays everywhere' },
  { id: 'hevc', label: 'HEVC', hint: '~40% smaller files' },
  { id: 'copy', label: 'No re-encode', hint: 'Fastest, original quality; cuts snap to keyframes' },
]

const CONTAINERS: { id: OutputContainer; label: string }[] = [
  { id: 'mp4', label: 'MP4' },
  { id: 'mov', label: 'MOV' },
  { id: 'mkv', label: 'MKV' },
]

export function OutputSettings({ source, value, onChange }: { source: SourceInfo; value: Settings; onChange: (v: Settings) => void }) {
  const set = (patch: Partial<Settings>) => onChange({ ...value, ...patch })
  const resolutions = allowedResolutions(source)
  const copy = value.codec === 'copy'
  const res = copy ? 'source' : value.resolution
  const size = targetSize(source, res)
  return (
    <div className="output-settings">
      <div className="field">
        <label>Colour (LUT)</label>
        <LutPicker value={value.lutId} onChange={(lutId) => set({ lutId })} disabled={copy} />
      </div>
      <div className="field">
        <label>Format</label>
        <div className="seg">
          {CONTAINERS.map((c) => (
            <button key={c.id} className={value.container === c.id ? 'on' : ''} onClick={() => set({ container: c.id })}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Video codec</label>
        <div className="seg">
          {CODECS.map((c) => (
            <button
              key={c.id}
              className={value.codec === c.id ? 'on' : ''}
              title={c.id === 'copy' && value.lutId ? 'Not available with a LUT (it needs re-encoding)' : c.hint}
              disabled={c.id === 'copy' && !!value.lutId}
              onClick={() => set({ codec: c.id })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="hint">{CODECS.find((c) => c.id === value.codec)?.hint}</div>
      </div>
      <div className="field">
        <label>Resolution</label>
        <div className="seg wrap">
          {resolutions.map((r) => (
            <button
              key={r}
              disabled={copy && r !== 'source'}
              className={res === r ? 'on' : ''}
              onClick={() => set({ resolution: r })}
              title={r === 'source' ? `${source.width}×${source.height}` : undefined}
            >
              {r === 'source' ? `Original · ${sourceLabel(source)}` : RES_LABEL[r]}
            </button>
          ))}
        </div>
        <div className="hint">
          Output {size.w}×{size.h} · never upscaled beyond the original {source.width}×{source.height}
        </div>
      </div>
      {!copy && (
        <>
          <div className="field">
            <label>
              Quality <span className="dim">{value.quality < 35 ? 'smaller file' : value.quality > 75 ? 'best' : 'balanced'}</span>
            </label>
            <input type="range" min={0} max={100} step={5} value={value.quality} onChange={(e) => set({ quality: Number(e.target.value) })} />
          </div>
          <div className="field row">
            <label className="check">
              <input type="checkbox" checked={value.hardware} onChange={(e) => set({ hardware: e.target.checked })} />
              Hardware encoding {window.tencut.platform === 'darwin' ? '(VideoToolbox)' : ''}
            </label>
            <label className="check">
              <input type="checkbox" checked={value.fadeMs > 0} onChange={(e) => set({ fadeMs: e.target.checked ? 250 : 0 })} />
              Fade between rallies
            </label>
          </div>
        </>
      )}
    </div>
  )
}

function sourceLabel(s: SourceInfo): string {
  const short = Math.min(s.width, s.height)
  if (short >= 2160) return '4K'
  if (short >= 1440) return '2K'
  return `${short}p`
}
