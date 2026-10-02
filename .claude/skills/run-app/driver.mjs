// Drive the TenCut Electron app for verification. Starts the built app (npm run build first) and accepts
// commands over HTTP so an agent can poke it step by step:
//   node .claude/skills/run-app/driver.mjs &      # listens on 127.0.0.1:7788
//   curl -s localhost:7788 -d 'open /path/video.mp4'
// Commands: open <path>[|<path>…] | ss <name> | click <css> | click-text <text> | eval <js> | text [css] | press <key> | main <js> | quit
import { _electron as electron } from 'playwright-core'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '../../..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const bin = process.platform === 'darwin'
  ? path.join(APP_DIR, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  : path.join(APP_DIR, 'node_modules/electron/dist/electron')

// TENCUT_PACKAGED=1 drives the electron-builder output (dist/mac-arm64/TenCut.app) instead of the dev build.
const packaged = path.join(APP_DIR, 'dist/mac-arm64/TenCut.app/Contents/MacOS/TenCut')
const app = process.env.TENCUT_PACKAGED
  ? await electron.launch({ executablePath: packaged, args: [], timeout: 30000 })
  : await electron.launch({ executablePath: bin, args: [APP_DIR], timeout: 30000 })
const page = await app.firstWindow()
await page.waitForSelector('.app', { timeout: 20000 })
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[renderer]', m.type(), m.text()) })
const logs = []
app.process().stdout?.on('data', (d) => logs.push(String(d)))
app.process().stderr?.on('data', (d) => logs.push(String(d)))

const cmds = {
  // Stub the native file dialogs so flows can run unattended, then click the open button.
  // Several files (a split match): separate paths with '|'.
  async open(p) {
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
    }, p.split('|'))
    return cmds['click-text']('Open match recording')
  },
  async saveas(p) {
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }) }, p)
    return 'ok'
  },
  async ss(name) {
    const f = path.join(SHOT_DIR, `${name || Date.now()}.png`)
    await page.screenshot({ path: f })
    return f
  },
  async click(sel) {
    return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return 'NOT_FOUND'; el.click(); return 'OK' }, sel)
  },
  async 'click-text'(t) {
    return page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, label, a')]
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t))
      if (!el) return 'NOT_FOUND'
      el.click(); return 'OK ' + el.textContent.trim().slice(0, 40)
    }, t)
  },
  // Click at normalized coordinates (0..1) of an element, e.g. "clickat .cp-stage svg 0.5 0.5"
  async clickat(arg) {
    const m = arg.match(/^(.*)\s+([\d.]+)\s+([\d.]+)$/)
    const box = await page.locator(m[1]).first().boundingBox()
    await page.mouse.click(box.x + box.width * Number(m[2]), box.y + box.height * Number(m[3]))
    return 'OK'
  },
  async eval(js) { return JSON.stringify(await page.evaluate(js)) },
  async main(js) { return JSON.stringify(await app.evaluate(new Function('electron', `return (${js})`))) },
  async text(sel) { return page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null) },
  async press(k) { await page.keyboard.press(k); return 'OK' },
  async logs() { return logs.splice(0).join('') },
  async quit() { setTimeout(() => process.exit(0), 100); await app.close().catch(() => {}); return 'bye' },
}

http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', async () => {
    const [cmd, ...rest] = body.trim().split(' ')
    let out
    try { out = cmds[cmd] ? await cmds[cmd](rest.join(' ')) : `unknown: ${cmd}` } catch (e) { out = 'ERROR: ' + e.message }
    res.end(String(out) + '\n')
  })
}).listen(7788, '127.0.0.1', () => console.log('driver ready on 7788'))
