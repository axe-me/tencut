// Generates the TenCut logo: a tennis ball cut vertically three times into four slices.
//   node scripts/make-icon.mjs
// Writes resources/icon.svg + resources/icon.png (1024², macOS app icon; electron-builder makes the .icns)
// and src/renderer/src/assets/logo.svg (ball only, for the UI).
import { mkdirSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const CX = 512
const CY = 512
const R = 262
const SLICES = 4
const GAP = 30 // spread between slices
const STAGGER = [-14, 8, -8, 14] // slight vertical offsets so it reads as "cut"

function ballDefs(id) {
  // Seams: two arcs bulging towards the centre, like the ")(" lines of a real ball, clipped to the ball.
  const k = 1.18 * R
  const sr = 0.93 * R
  return `
    <radialGradient id="${id}-felt" cx="38%" cy="32%" r="75%">
      <stop offset="0" stop-color="#f1fb7a"/>
      <stop offset="0.45" stop-color="#d4ea2f"/>
      <stop offset="1" stop-color="#93ad12"/>
    </radialGradient>
    <clipPath id="${id}-disc"><circle cx="${CX}" cy="${CY}" r="${R}"/></clipPath>
    <g id="${id}">
      <circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#${id}-felt)"/>
      <g clip-path="url(#${id}-disc)" fill="none" stroke="#fbfdf2" stroke-width="${R * 0.085}" stroke-linecap="round">
        <circle cx="${CX - k}" cy="${CY}" r="${sr}"/>
        <circle cx="${CX + k}" cy="${CY}" r="${sr}"/>
      </g>
    </g>`
}

function slicedBall(id) {
  const w = (2 * R) / SLICES
  const x0 = CX - R
  let clips = ''
  let parts = ''
  for (let i = 0; i < SLICES; i++) {
    clips += `<clipPath id="${id}-s${i}"><rect x="${x0 + i * w}" y="${CY - R - 2}" width="${w}" height="${2 * R + 4}"/></clipPath>`
    const dx = (i - (SLICES - 1) / 2) * GAP
    parts += `<g transform="translate(${dx} ${STAGGER[i]})"><g clip-path="url(#${id}-s${i})"><use href="#${id}"/></g></g>`
  }
  return { clips, parts }
}

function iconSvg() {
  const { clips, parts } = slicedBall('ball')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c5aa8"/>
      <stop offset="1" stop-color="#16315f"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
    ${ballDefs('ball')}
    ${clips}
  </defs>
  <!-- macOS icon grid: 824² rounded square centred on a 1024² canvas -->
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <!-- court line hint -->
  <rect x="100" y="742" width="824" height="10" fill="#ffffff" opacity="0.22"/>
  <ellipse cx="${CX}" cy="${CY + R + 34}" rx="${R * 1.05}" ry="26" fill="#050b18" opacity="0.45" filter="url(#shadow)"/>
  ${parts}
</svg>`
}

function logoSvg() {
  const { clips, parts } = slicedBall('lb')
  // Tight viewBox around the sliced ball.
  const pad = 8
  const x = CX - R - 1.5 * GAP - pad
  const y = CY - R - 14 - pad
  const w = 2 * R + 3 * GAP + 2 * pad
  const h = 2 * R + 28 + 2 * pad
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}"><defs>${ballDefs('lb')}${clips}</defs>${parts}</svg>`
}

mkdirSync('resources', { recursive: true })
mkdirSync('src/renderer/src/assets', { recursive: true })
const icon = iconSvg()
writeFileSync('resources/icon.svg', icon)
writeFileSync('resources/icon.png', new Resvg(icon, { fitTo: { mode: 'width', value: 1024 } }).render().asPng())
writeFileSync('src/renderer/src/assets/logo.svg', logoSvg())
console.log('wrote resources/icon.svg, resources/icon.png, src/renderer/src/assets/logo.svg')
