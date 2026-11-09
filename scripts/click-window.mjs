#!/usr/bin/env node
// Click inside a window through the same capture helper the plugin uses.
//   node scripts/click-window.mjs --hwnd 1234 --x 1463 --y 1003 [--count 1]
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowCapture } from '../host/window.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const hwnd = Number(arg('hwnd', '0'))
const x = Number(arg('x', '0'))
const y = Number(arg('y', '0'))
const count = Number(arg('count', '1'))
const hold = Number(arg('hold', '60'))
if (!hwnd || !x || !y) {
  console.error('usage: node scripts/click-window.mjs --hwnd <HWND> --x <px> --y <px> [--count 1]')
  process.exit(1)
}

const capture = new WindowCapture({ helperPath: join(root, 'host', 'window-capture.ps1'), logger: { info() {}, warn() {}, error() {} } })
const started = await capture.start(hwnd, { fps: 10, quality: 80, maxWidth: 0 })
await new Promise((r) => setTimeout(r, 700))

// the helper speaks normalized 0..1 coordinates, not pixels
const frame = capture.last()
const width = frame?.width ?? started?.width ?? 0
const height = frame?.height ?? started?.height ?? 0
if (!width || !height) {
  console.error('could not measure the window; aborting instead of guessing')
  capture.stop()
  process.exit(1)
}
const nx = x / width
const ny = y / height
for (let i = 0; i < count; i += 1) {
  await capture.pointer(nx, ny, 'move')
  await new Promise((r) => setTimeout(r, 80))
  await capture.pointer(nx, ny, 'down')
  await new Promise((r) => setTimeout(r, hold))
  await capture.pointer(nx, ny, 'up')
  await new Promise((r) => setTimeout(r, 250))
}
await new Promise((r) => setTimeout(r, 300))
capture.stop()
console.log(`clicked ${count}x at ${x},${y} (${(nx * 100).toFixed(1)}%, ${(ny * 100).toFixed(1)}%) in ${hwnd}`)
