export function fmtTime(sec: number, withTenths = false): string {
  if (!isFinite(sec)) return '--:--'
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const t = withTenths ? `.${Math.floor((s * 10) % 10)}` : ''
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}${t}` : `${m}:${String(ss).padStart(2, '0')}${t}`
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtBytes(b: number): string {
  if (b < 1e6) return `${(b / 1e3).toFixed(0)} KB`
  if (b < 1e9) return `${(b / 1e6).toFixed(0)} MB`
  return `${(b / 1e9).toFixed(2)} GB`
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

export function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v))
}
