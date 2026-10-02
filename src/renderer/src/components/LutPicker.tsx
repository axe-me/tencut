import { useEffect, useState } from 'react'
import type { LutInfo } from '../../../main/luts'

/**
 * Pick a colour LUT from the library, or load a new .cube (copied into the app, so it's there next time).
 * The choice becomes the default for new projects.
 */
export function LutPicker({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: string | null | undefined
  onChange: (id: string | null) => void
  disabled?: boolean
  /** Just the dropdown (player controls). */
  compact?: boolean
}) {
  const [luts, setLuts] = useState<LutInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const refresh = () => window.tencut.luts.list().then((l) => setLuts(l.luts))
  useEffect(() => {
    refresh()
  }, [])

  const choose = (id: string | null) => {
    onChange(id)
    window.tencut.luts.setDefault(id)
  }

  const load = async () => {
    setError(null)
    try {
      const info = await window.tencut.luts.import()
      if (!info) return
      await refresh()
      choose(info.id)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  const current = luts.find((l) => l.id === value) ?? null
  if (compact) {
    return (
      <select
        className="lut-compact"
        value={current?.id ?? ''}
        title={error ?? 'Colour LUT for preview and export'}
        onChange={(e) => (e.target.value === '__load' ? load() : choose(e.target.value || null))}
      >
        <option value="">No LUT</option>
        {luts.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
        <option value="__load">Load .cube LUT…</option>
      </select>
    )
  }
  return (
    <div className="lut-picker">
      <div className="lut-row">
        <select
          value={current?.id ?? ''}
          disabled={disabled}
          onChange={(e) => (e.target.value === '__load' ? load() : choose(e.target.value || null))}
        >
          <option value="">None – footage as recorded</option>
          {luts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          <option value="__load">Load .cube LUT…</option>
        </select>
        {current && (
          <button
            className="icon tiny"
            title="Remove this LUT from the library"
            onClick={async () => {
              await window.tencut.luts.remove(current.id)
              await refresh()
              onChange(null)
            }}
          >
            ✕
          </button>
        )}
      </div>
      {error && <div className="hint warn">{error}</div>}
      <div className="hint">
        {disabled
          ? 'LUTs need re-encoding – pick H.264 or HEVC.'
          : current
            ? `${current.size}³ LUT · applied to preview, analysis and export`
            : 'For log footage (D-Log, S-Log…). Loaded LUTs are kept for next time.'}
      </div>
    </div>
  )
}
