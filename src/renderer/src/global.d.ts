import type { TenCutApi } from '../../preload/index'

declare global {
  interface Window {
    tencut: TenCutApi
  }
}
export {}
