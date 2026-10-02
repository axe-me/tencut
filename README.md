# TenCut

Offline desktop app (Electron) that takes a long tennis recording, for example 1 hour of 4K, finds the rallies, and exports only the rallies. Ball collection, walking back and changeovers are cut out.

Everything runs locally: ffmpeg and ffprobe are bundled, there are no network calls and no cloud models.

## Using it

1. **Open** a recording. Drag and drop works too. If the camera split the match into several files, select them all.
2. **Mark your court** on any frame. Click four points, and the fitted court lines are drawn over the frame so you can check the fit.
   - **Whole court visible:** click the near-baseline corners, then the far-baseline corners.
   - **Far baseline hard to see:** for low cameras behind one end. Click the near-baseline corners, then the two points where the net meets the sidelines.
3. **Pick the output** before starting:
   - Format: MP4, MOV or MKV.
   - Codec: H.264, HEVC, or no re-encode.
   - Resolution: 720p, 1080p, 2K or 4K. Only sizes up to the original are offered.
4. **Find rallies.** Analysis streams the file. For 4K on Apple Silicon it runs at roughly 20× real time.
5. **Review.** You get a player, a zoomable timeline with an activity curve, and a list of rallies.
   - Adjust:
     - Untick rallies you don't want.
     - Drag rally edges to trim them.
     - Mark in/out (`I` / `O`) to add a rally that was missed.
     - Split a rally at the playhead (`S`).
   - Fine-tune:
     - Move the strict ↔ loose slider; it re-runs detection instantly.
     - Set the lead-in and tail padding.
   - "Play kept only" previews the cut.
   - Edits persist per file.
6. **Export.** Each rally is encoded separately with hardware encoding (VideoToolbox), then the pieces are joined without re-encoding.

Shortcuts:

| Key | Action |
|---|---|
| Space | Play / pause |
| ↑ ↓ | Previous / next rally |
| ← → | Back / forward 5 s (Shift: 1 s) |
| K | Keep or remove the selected rally |
| I / O | Mark in / out (adds a rally) |
| S | Split at the playhead |
| P | Toggle "Play kept only" |
| Wheel | Zoom the timeline (horizontal scroll pans) |

## Development

```bash
npm install
node node_modules/electron/install.js   # only if the Electron binary didn't download during install
npm run dev                             # app with hot reload
npm test                                # core unit tests (node:test)
npm run typecheck
npm run build && npx electron-builder --mac --dir   # packaged app in dist/mac-arm64
```

Headless tools, used while tuning detection on real footage:

```bash
node --experimental-strip-types scripts/analyze-cli.ts match.MP4 --court half:0.146,0.509,0.599,0.701,0.885,0.488,0.483,0.434 --out analysis.json
node --experimental-strip-types scripts/segment-cli.ts analysis.json 0.5 segs.json
node --experimental-strip-types scripts/export-cli.ts analysis.json segs.json out.mp4 1080p h264
```

## Architecture

```
src/core/          pure TypeScript, no Electron (runs under plain Node for CLI + tests)
  ffmpeg.ts        bundled binary resolution (asar-aware), probe, spawn helpers
  court.ts         4-point homography → court model, region of interest (ROI) polygon, mask rasterizer
  audio.ts         streaming racket-impact detector (FFT band flux × spectral flatness, adaptive peaks)
  video.ts         per-frame features: ROI motion + ball candidates (3-frame difference ∧ optic-yellow colour)
  video-worker.ts  worker_threads entry: one ffmpeg per time chunk → FrameAnalyzer
  analyze.ts       orchestrates parallel chunk workers + the audio pass, collects features
  tracker.ts       links candidates into trajectories; keeps fast, coherent ones (ball) and drops clothing/noise
  segment.ts       evidence → rallies (hysteresis, gap merging, padding); runs in ms, so the UI re-runs it live
  export.ts        per-clip encode (seek straight to each rally) + concat demuxer join
src/main/          Electron main: window, IPC, tencut-media:// protocol (Range support), caches, export
  analysis-host.ts utilityProcess that hosts analysis, so the UI and main process never block
src/preload/       contextBridge API (window.tencut)
src/renderer/      React UI: Home → Setup (court + output) → Analyzing → Review / Export
```

### Streaming and memory

The source file is never loaded into memory.

- **Analysis:** the timeline is split into 90-second chunks, and a pool of worker threads runs them, by default half the CPU cores (4–6). Each worker runs its own ffmpeg:
  - hardware HEVC/H.264 decode;
  - `fps=15` and a downscale to 1280 px wide;
  - a crop to the court ROI's bounding box;
  - raw RGB piped to the worker.

  Each worker keeps only three frames in a ring buffer. Pipe backpressure throttles ffmpeg, so memory stays flat: about 600 MB RSS in total for the 28-minute 4K test file.
- **Audio:** one ffmpeg process decodes 16 kHz mono PCM into the streaming onset detector. A whole hour takes a few seconds.
- **Cache:** results are cached per file (path, size and mtime) and court. Reopening a file is instant, and detection tuning never needs another decode.
- **Preview:** the `<video>` element streams from the `tencut-media://` protocol, which serves byte ranges. Seeking in a 17 GB file is instant.
- **Export:** each kept rally is encoded straight from its own seek point, so dead time is never decoded. Two encodes run in parallel, then the pieces are joined with `-c copy`.

### Test file numbers (M1 Max)

Test file: `match.MP4`, a 27m43s DJI recording, 3840×2160 HEVC Main10 at 29.97 fps and 80 Mb/s (17.2 GB).

| Step | Result |
|---|---|
| Analysis | 88 s without pose (19–23× real time, about 600 MB RSS); 150–165 s with pose (10–13× real time) |
| Detection | 54 clips, keeping 20m48s of 27m43s at default sensitivity, with pose. This recording is mostly continuous hitting with short breaks. |
| Export | 1080p H.264, VideoToolbox: about 8× real time (11m46s of rallies in 1m39s) |
| In-app preview | 4K HEVC 10-bit plays with hardware decode |

The export timing was measured before the final detection tuning, when the default kept 43 rallies (11m46s).

## How detection works, and why

The test footage is typical amateur footage:
- a fixed camera that is low and off to one side;
- neighbouring courts in frame, so their players, balls and sounds are all visible or audible;
- a ball only 4–14 px across in 4K.

On footage like this, a single signal isn't reliable.

1. **Court ROI:** the user's four clicks give a homography. The court plus run-off, extruded upwards, becomes the analysis mask, so the neighbouring courts are ignored.
2. **Ball candidates:** pixels that differ from both the previous and the next frame (something passed through) and are optic-yellow in HSV, i.e. hue 45–112°. Connected blobs of 2–28 px are kept.
3. **Trajectories:** candidates are linked with a constant-velocity gate. A track counts as the ball if either:
   - it is fast relative to frame width and actually travels; or
   - it is slower but its candidates are *isolated* (few moving pixels around them) and it still travels.

   The second case matters for low cameras behind the court: shots travelling towards or away from the lens barely move across the image. A per-candidate "clutter" value tells these apart from the yellow-green shirts and shoes that also pass the colour test, because those sit on a moving body.
4. **Audio hits** are short broadband transients in the 1–6 kHz band, with an adaptive threshold. They are supporting evidence only, because other courts are audible. Audio never creates a rally on its own.
5. **Segmentation:** a rally is a stretch where the ball keeps flying with short gaps.
   - Evidence is ball-in-flight coverage smoothed over 2.4 s, plus audio.
   - Hysteresis is controlled by the sensitivity slider.
   - Edges are snapped to the first and last ball flight.
   - Gaps under 2.5 s are merged.
   - A rally needs about 1.3 s of in-flight ball in total.
   - Lead-in and tail padding are added.

A ball bounced in place before a serve (a near-vertical track with no sideways travel) is down-weighted.

6. **Serves:** a toss (a near-vertical rise) followed within 2 s by a loud racket hit is a serve. A serve that isn't already inside a rally becomes its own short clip, so faults stay in the edit. The served ball itself is often a faint motion-blurred streak that the colour test misses, but the toss is slow and clearly visible.
7. **Audio-extended edges:** loud hits just after a clip's last tracked flight extend the clip. This catches untracked final shots and serves.
8. **Players (pose model, on by default):** in each analysis worker, YOLOX-tiny finds people about once a second, and only those whose feet are on the marked court are kept. RTMPose-t then follows each player's skeleton at 5 fps. Both models are Apache-2.0, run through onnxruntime-node and are bundled in `resources/models`. From the keypoints the analysis derives:
   - **swings:** wrist speed relative to the shoulders, normalised by torso length so the small far player counts too, plus at least one torso length of arm sweep;
   - **overhead swings:** serves and smashes;
   - **ball pickups:** a short bent-over episode on court.

   Swings that **alternate between the near and far player** within 0.6–3.5 s count as ball in play, even when the ball isn't visible. A player bouncing the ball or shadow-swinging stays on one side, so that doesn't count. An overhead swing with a racket impact at the same moment is a serve. Pickups damp activity outside exchanges, so ball-collection time is cut.

   Cost: on the test file, analysis drops from about 19× to about 10–13× real time, roughly 6 minutes for an hour of 4K on an M1 Max. The setup screen has a switch to turn it off.

The heuristics borrow from BadmintonStudio (audio/motion fusion, hysteresis), tennisvision and leecuber's rally editor (gap bridging, padding), and the RallyClip decoder.

**Accuracy is not measured yet.** There is no labelled ground truth. Tuning so far:
- I compared track overlays on frames;
- I spot-checked detected and rejected stretches of `match.MP4` by eye;
- one fix came from this. A stretch of real play from 11:20–13:30 was missed at first because shots towards and away from the camera look slow in image space. The speed weighting was relaxed.

The review UI is the safety net. Labelling a few matches and measuring precision and recall is the next step for detection quality.

## Research notes

### Projects looked at

| Project | Verdict |
|---|---|
| WhynotGit2025/TennisVAR | Answers questions about clips that are already cut (DINOv3 + TrackNet + Qwen3-VL-8B). No weights released. Does no rally segmentation. Not usable offline. |
| HarshTomar1234/Tennis-Vision | YOLOv8x + TrackNet + ResNet-50 court keypoints. Built for a single continuous rally; about 6 min to process a 19 s clip. Worth borrowing: its rule-based rally decoder and its homography gating. |
| iroblesrazzaq/RallyClip | The only shipped trained tennis rally segmenter: YOLOv8n-pose feeding a temporal convolutional network (TCN). Ships ONNX models (24 MB). The repo has no licence, and the YOLO models are AGPL. |
| nttcom/WASB-SBDT | MIT-licensed small ball tracker (HRNet, 288×512) with tennis weights. The cleanest ML ball tracker to adopt. |
| yastrebksv TrackNet / TennisCourtDetector | Easy ONNX export (about 43 MB each), but the weights are unlicensed. |
| BadmintonStudio, tennisvision, leecuber skill, TTLab | Rally heuristics (audio/motion fusion, gap rules). Ideas reused here. |

### Model runtime: why not transformers.js

transformers.js is valuable for Hub pipelines and tokenizers. TrackNet, WASB and YOLO aren't transformers.js architectures, and their pre- and post-processing would be custom code anyway. You would end up calling raw ONNX Runtime underneath, while also pulling in `sharp` and a dev-pinned onnxruntime-web build.

The right runtime for adding ML models is **onnxruntime-node** (1.30) inside the existing `utilityProcess`:
- its npm build ships the CoreML execution provider on Apple Silicon and DirectML on Windows;
- it is an N-API module, so no electron-rebuild is needed;
- the same worker-pool structure is reused.

onnxruntime-web with WebGPU in a hidden renderer is the fallback. The current pipeline needs no model at all, and decode is the bottleneck: one hour of 4K takes about 3 minutes.

## Roadmap

**Multi-file matches (done):** cameras split long recordings into several files (DJI ~4 GB, GoPro chapters).
- Open or drop all the parts together. They're naturally sorted (`DJI_0002` before `DJI_0010`) and can be reordered, added to or removed in setup.
- Each file is analysed and cached on its own. `src/core/timeline.ts` joins the results into one match timeline, so a rally that crosses a file boundary stays one rally.
- The player switches files seamlessly during playback and seeking.
- Export splits boundary-crossing rallies into back-to-back clips. Every part is encoded to the first file's format so the join is clean.

**Detection quality:**
- a labelled evaluation set;
- optionally an ML ball tracker (WASB exported to ONNX, run on ROI tiles only around candidate windows). It would help most with blurred serves and smashes and the tiny far-court ball;
- RTMPose on the CoreML execution provider (3.7 ms against 7.9 ms on CPU) to speed up pose;
- automatic court-line detection to pre-fill the four points.

**Licensing of models:** the bundled models are Apache-2.0 (OpenMMLab). Ultralytics YOLO (v8/11, including the pose models RallyClip uses) is AGPL-3.0, which was avoided on purpose. See `resources/models/README.md`.

**Distribution:**
- The bundled `ffmpeg-static` and `ffprobe-static` binaries are GPL builds, and ffprobe-static is old (4.4). A commercial release should ship its own LGPL ffmpeg 7 or 8 build, configured with `--enable-videotoolbox` and without x264/x265.
- The release also needs signing and notarisation, and a Windows build (d3d11va decode, `h264_qsv` / `h264_nvenc` / `h264_amf` encode mapping).
