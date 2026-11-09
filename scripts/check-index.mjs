#!/usr/bin/env node
// Structural check for docs/plugin-index.json (format 1), mirroring the rules
// DSH's dsh-plugin-market-index validator enforces. Dependency-free so CI or a
// pre-commit step can run it without the Harness app.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const doc = JSON.parse(readFileSync(join(root, 'docs', 'plugin-index.json'), 'utf8'))
const fail = (path, rule) => {
  throw new Error(`${path}: ${rule}`)
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const PACKAGE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const COMMIT = /^[0-9a-f]{40}$/
const LANGS = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/

if (doc.format !== 1) fail('$.format', 'must be 1')
if (!doc.title || typeof doc.title !== 'object') fail('$.title', 'must be an object of language ids')
for (const lang of Object.keys(doc.title)) if (!LANGS.test(lang)) fail(`$.title.${lang}`, 'must be a lowercase language id')
if (!Array.isArray(doc.plugins)) fail('$.plugins', 'must be an array')
const names = new Set()
for (const [i, plugin] of doc.plugins.entries()) {
  const at = `$.plugins[${i}]`
  if (!PACKAGE.test(plugin.name)) fail(`${at}.name`, 'must be a valid npm package name')
  if (names.has(plugin.name)) fail(`${at}.name`, `duplicates ${plugin.name}`)
  names.add(plugin.name)
  if (!Array.isArray(plugin.versions) || !plugin.versions.length) fail(`${at}.versions`, 'must be a non-empty array')
  const seen = new Set()
  for (const [j, version] of plugin.versions.entries()) {
    const vat = `${at}.versions[${j}]`
    if (!SEMVER.test(version.version)) fail(`${vat}.version`, 'must be an exact SemVer version')
    if (seen.has(version.version)) fail(`${vat}.version`, `duplicates ${version.version}`)
    seen.add(version.version)
    if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0) fail(`${vat}.publishTimestamp`, 'must be integer Unix seconds')
    const source = version.source ?? fail(`${vat}.source`, 'is required')
    if (source.type === 'git') {
      if (!COMMIT.test(source.commit)) fail(`${vat}.source.commit`, 'must be a lowercase 40-hex-digit commit SHA')
      if (!/^https?:\/\//.test(source.url)) fail(`${vat}.source.url`, 'must be an http(s) URL')
    } else if (source.type === 'npm') {
      // registry is optional
    } else {
      fail(`${vat}.source.type`, 'must be "npm" or "git"')
    }
  }
}
console.log(`index OK — ${doc.plugins.length} plugin(s): ${[...names].join(', ')}`)
