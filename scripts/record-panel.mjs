#!/usr/bin/env node
// Record the panel inside the running Harness window into a GIF.
//
// Deliberately independent of the plugin's own state: attaching the DSH window
// through the panel would make the panel render its own capture. This spawns a
// bare WindowCapture, grabs frames at a fixed interval, crops one region and
// hands the frames to Pillow for assembly.
//
//   node scripts/record-panel.mjs --hwnd 2036490 --frames 36 --interval 120 \
//        --crop 875,55,1600,1015 --out docs/images/demo.gif
//
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowCapture } from '../host/window.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const hwnd = Number(arg('hwnd', '0'))
const frames = Number(arg('frames', '36'))
const interval = Number(arg('interval', '120'))
const out = resolve(root, arg('out', 'docs/images/demo.gif'))
const crop = arg('crop', '')
const width = Number(arg('width', '720'))

if (!hwnd) {
  console.error('usage: node scripts/record-panel.mjs --hwnd <HWND> [--frames 36] [--interval 120] [--crop x1,y1,x2,y2] [--out docs/images/demo.gif]')
  process.exit(1)
}

if (!WindowCapture.supported) {
  console.error('native capture is unavailable on this platform')
  process.exit(1)
}

const workdir = join(root, '.shots-tmp')
rmSync(workdir, { recursive: true, force: true })
mkdirSync(workdir, { recursive: true })

const capture = new WindowCapture({
  helperPath: join(root, 'host', 'window-capture.ps1'),
  logger: { info() {}, warn() {}, error: (msg) => console.error(msg) },
})
capture.on?.('error', () => {})

console.log(`attaching ${hwnd} …`)
const status = await capture.start(hwnd, { fps: 10, quality: 90, maxWidth: 0 })
if (!status?.ok && !status?.running) {
  console.error('attach failed:', JSON.stringify(status))
  process.exit(1)
}

await new Promise((r) => setTimeout(r, 900))
const files = []
let last = 0
for (let i = 0; i < frames; i += 1) {
  const frame = await capture.waitForFrame(last, 2000)
  if (frame) {
    last = frame.seq
    const file = join(workdir, `f${String(files.length).padStart(3, '0')}.jpg`)
    writeFileSync(file, frame.jpeg)
    files.push(file)
  }
  await new Promise((r) => setTimeout(r, interval))
}
capture.stop()
console.log(`captured ${files.length} frames`)

if (files.length < 3) {
  console.error('not enough frames — is the window still open?')
  process.exit(1)
}

const [x1, y1, x2, y2] = (crop || ',,').split(',').map((v) => Number(v) || 0)
const py = `
import sys, glob, os
from PIL import Image
src, out, crop, width = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
x1, y1, x2, y2 = [int(v) for v in crop.split(',')] if crop else (0, 0, 0, 0)
files = sorted(glob.glob(os.path.join(src, 'f*.jpg')))
imgs = []
for f in files:
    im = Image.open(f).convert('RGB')
    if x1 or y1 or x2 or y2:
        im = im.crop((x1, y1, x2 or im.width, y2 or im.height))
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    imgs.append(im)
if not imgs:
    sys.exit('no frames')
pal = [im.convert('P', palette=Image.ADAPTIVE, colors=192) for im in imgs]
pal[0].save(out, save_all=True, append_images=pal[1:], duration=90, loop=0, optimize=True, disposal=2)
print(f'gif {out} {imgs[0].size[0]}x{imgs[0].size[1]} frames={len(pal)}')
`
const python = process.env.DSH_PYTHON || 'python'
try {
  console.log(execFileSync(python, ['-c', py, workdir, out, crop, String(width)], { encoding: 'utf8' }).trim())
} catch (error) {
  console.error('gif assembly failed:', String(error.stderr ?? error.message).slice(0, 400))
  console.error(`frames kept in ${workdir}`)
  process.exit(1)
}
