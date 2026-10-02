import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Live colour-graded preview: draws the <video> through a 3D LUT with WebGL2 on a canvas laid over it.
 * Runs on the GPU, so 4K playback stays smooth. The video element underneath keeps doing the playback,
 * seeking and audio; this only repaints its frames.
 */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D u_video;
uniform sampler3D u_lut;
uniform float u_size;
uniform vec3 u_dmin;
uniform vec3 u_dmax;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec3 c = texture(u_video, v_uv).rgb;
  vec3 x = clamp((c - u_dmin) / (u_dmax - u_dmin), 0.0, 1.0);
  // Sample texel centres so 0 and 1 hit the first and last LUT entries exactly.
  vec3 coord = x * ((u_size - 1.0) / u_size) + 0.5 / u_size;
  outColor = vec4(texture(u_lut, coord).rgb, 1.0);
}`

interface LutData {
  size: number
  data: Float32Array
  domainMin: number[]
  domainMax: number[]
}

export function LutView({ video, lutId, enabled }: { video: RefObject<HTMLVideoElement | null>; lutId: string | null | undefined; enabled: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [lut, setLut] = useState<LutData | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLut(null)
    if (lutId)
      window.tencut.luts
        .data(lutId)
        .then((d) => alive && setLut(d))
        .catch((e) => alive && setFailed((e as Error).message))
    return () => {
      alive = false
    }
  }, [lutId])

  useEffect(() => {
    const cv = canvas.current
    const v = video.current
    if (!cv || !v || !lut || !enabled) return
    const gl = cv.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: false })
    if (!gl) {
      setFailed('WebGL2 not available – LUT preview disabled (export still applies it)')
      return
    }
    const prog = program(gl, VERT, FRAG)
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'a_pos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    // 3D LUT texture (RGB16F is filterable in WebGL2; trilinear interpolation between LUT points).
    const lutTex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, lutTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.FLOAT, lut.data)
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR)
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE)

    const vidTex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, vidTex)
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR)
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)

    gl.uniform1i(gl.getUniformLocation(prog, 'u_video'), 0)
    gl.uniform1i(gl.getUniformLocation(prog, 'u_lut'), 1)
    gl.uniform1f(gl.getUniformLocation(prog, 'u_size'), lut.size)
    gl.uniform3fv(gl.getUniformLocation(prog, 'u_dmin'), lut.domainMin)
    gl.uniform3fv(gl.getUniformLocation(prog, 'u_dmax'), lut.domainMax)

    let stopped = false
    let handle = 0
    const draw = () => {
      if (stopped || v.readyState < 2 || !v.videoWidth) return
      // Render at display resolution (capped), not the full 4K source: same look, far less GPU work.
      const scale = Math.min(1, (cv.clientWidth * devicePixelRatio) / v.videoWidth, 1920 / v.videoWidth)
      const w = Math.max(2, Math.round(v.videoWidth * scale))
      const h = Math.max(2, Math.round(v.videoHeight * scale))
      if (cv.width !== w || cv.height !== h) {
        cv.width = w
        cv.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, vidTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    // Repaint on every decoded frame while playing, and once after seeks / file switches while paused.
    const rvfc = 'requestVideoFrameCallback' in v
    const safeDraw = () => {
      try {
        draw()
      } catch (e) {
        // Never take the player down with the preview; export still applies the LUT.
        stopped = true
        setFailed(`LUT preview unavailable: ${(e as Error).message}`)
      }
    }
    const loop = () => {
      safeDraw()
      if (stopped) return
      handle = rvfc ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop)
    }
    loop()
    const once = () => requestAnimationFrame(safeDraw)
    v.addEventListener('seeked', once)
    v.addEventListener('loadeddata', once)
    const ro = new ResizeObserver(once)
    ro.observe(cv)
    return () => {
      stopped = true
      if (rvfc) v.cancelVideoFrameCallback(handle)
      else cancelAnimationFrame(handle)
      v.removeEventListener('seeked', once)
      v.removeEventListener('loadeddata', once)
      ro.disconnect()
      gl.deleteTexture(lutTex)
      gl.deleteTexture(vidTex)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
    }
  }, [lut, enabled, video])

  if (!lutId || !enabled) return null
  return (
    <>
      {!failed && <canvas ref={canvas} className="lut-canvas" />}
      {failed && <div className="video-error">{failed}</div>}
    </>
  )
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error')
    return s
  }
  const p = gl.createProgram()!
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs))
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error')
  return p
}
