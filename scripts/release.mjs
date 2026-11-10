#!/usr/bin/env node
// Release this bundle: checks → plugin index → commit → tag → push → release.
//
//   node scripts/release.mjs            # print the plan, change nothing
//   node scripts/release.mjs --yes      # do it (TAG/push/release)
//   node scripts/release.mjs --yes --publish   # also `npm publish`
//
// Needs GH_TOKEN for the GitHub release (push can use your normal git auth).
// `npm publish` needs `npm login` first; it is the only step that cannot be
// scripted around credentials.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = `v${version}`
const yes = process.argv.includes('--yes')
const publish = process.argv.includes('--publish')
const remote = (pkg.repository?.url ?? '').replace(/^git\+/, '')

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: options.quiet ? 'pipe' : 'inherit', ...options })

const plan = []
const step = (label, fn) => {
  plan.push({ label, fn })
}

step('syntax: index.js + client.js', () => {
  run(process.execPath, ['--check', 'index.js'], { quiet: true })
  run(process.execPath, ['--check', 'client.js'], { quiet: true })
})
step('client harness', () => run(process.execPath, ['scripts/client-harness.mjs'], { quiet: true }))
step('host harness', () => run(process.execPath, ['scripts/harness.mjs'], { quiet: true }))
step('plugin index', () => {
  run(process.execPath, ['scripts/make-index.mjs'], { quiet: true })
  run(process.execPath, ['scripts/check-index.mjs'], { quiet: true })
})
step('commit + tag', () => {
  const dirty = run('git', ['status', '--porcelain'], { quiet: true }).trim()
  if (dirty) run('git', ['add', '-A'])
  if (dirty) run('git', ['-c', 'user.name=dsh-game-preview', '-c', 'user.email=noreply@localhost', 'commit', '-m', `release: ${tag}`])
  try {
    run('git', ['rev-parse', tag], { quiet: true })
  } catch {
    run('git', ['-c', 'user.name=dsh-game-preview', '-c', 'user.email=noreply@localhost', 'tag', '-a', tag, '-m', `${tag}`])
  }
})
step('push main + tag', () => run('git', ['push', 'origin', 'main', tag]))
step('npm publish', () => run('npm', ['publish', '--access', 'public']))
step('GitHub release', () => {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('GH_TOKEN is not set')
  const api = remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const body = JSON.stringify({
    tag_name: tag,
    name: `${tag}`,
    body: `Release ${tag}. See CHANGELOG.md.`,
    draft: false,
    prerelease: false,
  })
  const out = execFileSync('curl', [
    '-s', '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    `https://api.github.com/repos/${api}/releases`,
    '-d', body,
  ], { encoding: 'utf8' })
  const parsed = JSON.parse(out)
  if (parsed.message && !parsed.html_url) throw new Error(parsed.message)
  console.log('release:', parsed.html_url)
})

console.log(`release ${tag} for ${pkg.name}`)
for (const [index, item] of plan.entries()) {
  const skip = item.label === 'npm publish' && !publish
  console.log(`  ${index + 1}. ${item.label}${skip ? '  (skipped, pass --publish)' : ''}`)
}
if (!yes) {
  console.log('\ndry run — pass --yes to execute')
  process.exit(0)
}

for (const item of plan) {
  if (item.label === 'npm publish' && !publish) continue
  console.log(`\n▸ ${item.label}`)
  try {
    item.fn()
  } catch (error) {
    console.error(`\n✗ ${item.label} failed: ${String(error?.stderr ?? error?.message ?? error).slice(0, 400)}`)
    process.exit(1)
  }
}
console.log(`\n✓ ${tag} released`)
