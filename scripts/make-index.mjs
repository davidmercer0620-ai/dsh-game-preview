#!/usr/bin/env node
// Generate the plugin-market index (format 1) for this bundle.
//
// The index is what DeepSeek Harness's experimental Discover tab reads when a
// user adds its URL; every version pins an exact git commit so an install is
// reproducible. Re-run after tagging a release and commit the result.
//
//   node scripts/make-index.mjs
//
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const git = (args) => execSync(`git ${args}`, { cwd: root, encoding: 'utf8' }).trim()

const commit = git('rev-parse HEAD')
const repo = (pkg.repository?.url ?? git('remote get-url origin')).replace(/^git\+/, '')
const homepage = pkg.homepage ?? repo.replace(/\.git$/, '')
const publishedAt = Math.floor(Number(git('show -s --format=%ct HEAD')))

const index = {
  format: 1,
  title: { en: 'DSH Game Preview', zh: 'DSH 游戏预览' },
  description: {
    en: 'A game studio plugin for DeepSeek Harness: play the game inside the sidebar, then package it.',
    zh: 'DeepSeek Harness 的游戏工作室插件：在侧栏里玩自己的游戏，顺手打包发布。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Game Preview', zh: '游戏预览' },
      description: {
        en: 'Run a Cocos, Godot, Unity or WeChat project and play it inside the right sidebar — window capture, input forwarding, PC/phone viewports, Web/APK packaging, bundle budgets and a QR code for device testing.',
        zh: '跑起 Cocos / Godot / Unity / 微信小游戏，在右侧栏里直接玩——窗口捕获、键鼠转发、PC/手机视口、Web/APK 封包、包体积预算，还能生成二维码手机试玩。',
      },
      author: '邮差游戏工作室 / Postman Game Studio',
      homepage,
      repository: { url: repo.replace(/\.git$/, '') },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: publishedAt,
          source: { type: 'git', url: repo, commit },
          engines: { dsh: pkg.engines?.dsh ?? '*' },
        },
      ],
    },
  ],
}

const out = join(root, 'docs', 'plugin-index.json')
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${out}`)
console.log(`plugin ${pkg.name}@${pkg.version} @ ${commit.slice(0, 8)}`)
