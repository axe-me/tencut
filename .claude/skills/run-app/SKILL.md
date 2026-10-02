---
name: run-app
description: Build, launch and drive the TenCut Electron app (open a video, mark the court, analyze, review, export) and take screenshots. Use when asked to run the app, check a UI change, or verify analysis/export end to end.
---

TenCut is an Electron + electron-vite app. Drive it with the Playwright driver at
`.claude/skills/run-app/driver.mjs`, which launches the app and accepts commands over HTTP on 127.0.0.1:7788.
macOS runs it directly (no xvfb).

## Build

```bash
npm install
node node_modules/electron/install.js   # if node_modules/electron/dist is missing (binary not downloaded)
npm run build                           # out/main, out/preload, out/renderer
```

## Run

```bash
node .claude/skills/run-app/driver.mjs &                      # dev build from out/
TENCUT_PACKAGED=1 node .claude/skills/run-app/driver.mjs &    # packaged app (npx electron-builder --mac --dir first)
curl -s localhost:7788 -d 'open /Users/axe/workspaces/tencut/match.MP4'   # stubs the open dialog and clicks Open
curl -s localhost:7788 -d 'ss 01-setup'                       # → .shots/01-setup.png
```

| command | does |
|---|---|
| `open <path>` | stub the native open dialog, click "Open match recording…" |
| `saveas <path>` | stub the native save dialog for the next export |
| `clickat <css> <fx> <fy>` | real mouse click at a fraction of an element's box (court points: `clickat .cp-stage svg 0.146 0.509`) |
| `click <css>` / `click-text <text>` | DOM click |
| `eval <js>` / `main <js>` | evaluate in renderer / main (`electron` is in scope for `main`) |
| `text [css]`, `press <key>`, `ss <name>`, `logs`, `quit` | |

Court points for `match.MP4` (mode "Far baseline hard to see"): 0.146 0.509 · 0.599 0.701 · 0.885 0.488 · 0.483 0.434.
Full flow: `open` → `click-text Far baseline hard to see` → 4× `clickat` → `click-text Find rallies` → poll
`eval !!document.querySelector(".review")` (~90 s) → `saveas …` → `click-text Export` → `click-text Choose file & export`.

## Gotchas

- Opening right after launch can take a few seconds; poll for `.setup`/`.review` instead of reading the page immediately.
- Analysis results are cached in `~/Library/Application Support/TenCut/analysis`; delete it to force a re-analysis.
  Project edits (court, segments, output settings) live in `…/TenCut/projects`, and a saved project with a cached
  analysis opens straight into Review.
- `main <js>` runs as an ESM function: `require` is not defined there.
