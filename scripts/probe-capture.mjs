// One-off probe: talk to host/window-capture.ps1 directly and print every line.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../host/window-capture.ps1', import.meta.url))
const hwnd = process.argv[2]
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (b) => console.log('[stderr]', String(b).trim().slice(0, 200)))
let frames = 0
child.stdout.on('data', (buf) => {
  for (const line of String(buf).split('\n')) {
    if (!line.trim()) continue
    const head = line.slice(0, 90)
    if (line.startsWith('DATA ')) {
      frames += 1
      const parts = line.split(' ')
      console.log('DATA', parts[1], parts[2] + 'x' + parts[3], 'cap=' + parts[4] + 'ms', 'enc=' + parts[5] + 'ms', 'b64=' + parts[7].length + 'B')
    } else {
      console.log(head)
    }
  }
})
child.stdin.write('PING\n')
setTimeout(() => child.stdin.write('LIST\n'), 400)
setTimeout(() => child.stdin.write(`START ${hwnd} 20 0 70\n`), 900)
setTimeout(() => {
  console.log('--- frames so far:', frames)
  child.stdin.write('STOP\n')
}, 3500)
setTimeout(() => child.stdin.write('QUIT\n'), 4500)
setTimeout(() => process.exit(0), 5500)
