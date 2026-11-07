// Read files out of an Electron asar archive without Electron (header walk + one read).
import { openSync, readSync, closeSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const archive = process.argv[2]
const pattern = process.argv[3] // substring match against the internal path
const out = process.argv[4]

const fd = openSync(archive, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerPickleSize = head.readUInt32LE(4)
const headerStringSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(headerStringSize)
readSync(fd, headerBuf, 0, headerStringSize, 16)
const index = JSON.parse(headerBuf.toString('utf8'))
const dataStart = 8 + headerPickleSize

const hits = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, path)
    else if (path.includes(pattern)) hits.push({ path, entry })
  }
}
walk(index, '')

if (!out) {
  for (const hit of hits.slice(0, 40)) console.log(hit.path, hit.entry.size ?? '')
  console.log(`total ${hits.length}`)
} else {
  const hit = hits.find((h) => h.path.endsWith(pattern.endsWith('.html') ? pattern : '')) ?? hits[0]
  if (!hit) throw new Error('no match for ' + pattern)
  const buf = Buffer.alloc(hit.entry.size)
  readSync(fd, buf, 0, hit.entry.size, dataStart + Number(hit.entry.offset))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buf)
  console.log('extracted', hit.path, hit.entry.size, '→', out)
}
closeSync(fd)
