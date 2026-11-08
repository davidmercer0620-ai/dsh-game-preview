// Dump one frame from host/window-capture.ps1 with proper line buffering.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../host/window-capture.ps1', import.meta.url))
const hwnd = process.argv[2]
const out = process.argv[3] ?? 'C:/Users/吴小凤/AppData/Local/Temp/probe-frame.jpg'

const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (b) => console.log('[stderr]', String(b).trim().slice(0, 200)))

let buffer = ''
let saved = 0
child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    if (!line.startsWith('DATA ')) {
      console.log(line.slice(0, 100))
      continue
    }
    if (saved >= 2) continue
    const parts = line.split(' ')
    const jpeg = Buffer.from(parts[7], 'base64')
    saved += 1
    writeFileSync(out.replace('.jpg', `-${saved}.jpg`), jpeg)
    console.log(`DATA ${parts[1]} ${parts[2]}x${parts[3]} cap=${parts[4]}ms enc=${parts[5]}ms black=${parts[6]} jpeg=${jpeg.length}B`)
  }
})

child.stdin.write('PING\n')
setTimeout(() => child.stdin.write(`START ${hwnd} 20 0 70\n`), 500)
setTimeout(() => child.stdin.write('STOP\n'), 3000)
setTimeout(() => child.stdin.write('QUIT\n'), 3600)
setTimeout(() => process.exit(0), 4600)
