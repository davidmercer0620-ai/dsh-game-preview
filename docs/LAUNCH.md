# 冲 1000 星：发布弹药包

这份文档只解决一件事：**让对的人看到它，并且愿意点 star**。

写好代码只是入场券。星数来自三个乘数：

```
星数 ≈ 人群规模 × 命中痛点的程度 × 传播次数
```

我们能控制的：
- **痛点精准度**：README 前 3 秒必须让人认出「这就是我的问题」
- **可信度**：真实截图、真实数据（15 fps 抓帧、1m20s 出 APK、TapTap 提交包 0.64 MB）
- **传播次数**：同一个包，发到 5 个不同的圈子，不是发一次

## 一、发布前清单（已完成 / 待办）

| 项 | 状态 | 说明 |
|---|---|---|
| README 英文优先 + 8 语言 | ✅ | 中文圈和英文圈各有一半机会 |
| 徽章（版本/许可/平台/零依赖） | ✅ | 零依赖是 DSH 插件里的差异化 |
| 真实截图 ×2 | ✅ | 手机视口 + Unity 原生捕获 |
| GitHub topics ×12 | ✅ | 决定被搜索到的概率 |
| 仓库描述 | ✅ | 一句话讲清「在侧栏里玩游戏」 |
| LICENSE (MIT) | ✅ | 没有许可证的项目没人敢用 |
| CHANGELOG | ✅ | 显得在维护 |
| 演示 GIF | ⬜ | 有会明显提升转化，录制成本高 |
| npm 发布 | ⬜ | **需要你 `npm login`**，这是最大的发现入口 |
| 社交预览图 | ⬜ | 需要在网页端上传（API 不支持） |

## 二、发布节奏（建议 7 天）

| 天 | 动作 | 为什么 |
|---|---|---|
| D1 | 发 **V2EX**（分享创造节点）+ **即刻** | 中文技术圈首发，反馈最快 |
| D2 | 发 **掘金**（长文：我怎么把引擎窗口抓进 AI 编辑器） | 长文留存量，SEO 长期收益 |
| D3 | 发 **Reddit r/gamedev** + **r/cocos2d** | 英文圈最大的游戏开发人群 |
| D4 | 发 **Hacker News**（Show HN） | 要么 0，要么爆；值得赌一次 |
| D5 | 发 **小红书 / B站动态**（短视频或图文） | 独立游戏圈，中文，转化率高 |
| D6 | 提交到 **awesome-deepseek** / **awesome-game-dev** 类清单 | 长期被动流量 |
| D6 | 在 DSH 的 **Discover（插件市场）** 里出现 | 用户在自己熟悉的入口里发现你（索引已就绪，见下） |
| D7 | 复盘：哪个渠道来的 star 最多，加码那一个 | 集中火力 |

> 关键：**同一周内**发出去。星数是「随时间衰减的脉冲」，分散发等于每次从零开始。

## 三、文案（直接复制）

### 3.1 Hacker News — Show HN

**标题**
```
Show HN: Play your Unity/Godot/Cocos game inside the coding agent's sidebar
```

**正文**
```
I build games with an AI coding agent, and the loop was always broken: the agent
edits code, I alt-tab to the engine, play, alt-tab back, describe what I saw.

So I wrote a DeepSeek Harness plugin that puts the game in the sidebar.

What it does:
- detects the engine (Cocos, Godot, Unity, WeChat DevTools, plain dev server,
  or an exported build) and starts the fastest loop for it
- captures the native window with PrintWindow (Windows), ~15 fps at 1920x1030
- forwards mouse and keyboard back into the window, so you actually play
- PC / phone / adaptive viewports (390x844 etc.) with the exported build
- packages: Web zip, Android APK via the project's own android/ shell, Windows EXE
- lists the project's own scripts (build:taptap, preflight, release:check) and runs them
- bundle sizes against the WeChat/Douyin/TapTap 4 MB lines
- a QR code so you can open the build on a phone over the LAN
- gives the agent tools: screenshot the current frame, read the process log

Zero runtime dependencies, Windows 10/11, MIT.

What I'd love feedback on: the capture path is PrintWindow (not WGC) because the
Windows SDK WinRT metadata isn't installed here; is WGC noticeably better for
you in practice?
```

### 3.2 Reddit — r/gamedev

**标题**
```
I put my game inside my AI coding agent's sidebar so I stop alt-tabbing (open source, Windows)
```

**正文**
```
The loop I wanted: agent writes the code, I play the game, we iterate — without
ever leaving one window.

It's a DeepSeek Harness plugin. It finds the engine, launches it, captures the
native window into the right sidebar, and forwards input so the preview is
playable. Same panel also packages the build (web zip / APK / your own
build:taptap script) and shows bundle sizes against the 4 MB mini-game limits.

Numbers from real use: Unity editor at 1920x1030, 15.2 fps, ~107 KB JPEG per
frame; an Android APK built in 1m20s through the project's own Gradle shell.

Repo (MIT, no runtime deps): <link>
Happy to answer anything about the capture path or the packaging side.
```

### 3.3 V2EX — 分享创造

**标题**
```
[分享] 把游戏画面塞进 AI 编辑器的侧边栏，边写代码边玩
```

**正文**
```
用 AI 写游戏的时候，最烦的是回路断掉：agent 改完代码，我得切到引擎里跑一遍，
再切回来描述"刚才那个按钮歪了"。

所以写了个 DeepSeek Harness 插件，把游戏直接放进右侧栏：

· 自动识别引擎（Cocos / Godot / Unity / 微信开发者工具 / dev server / 导出包）
· 抓原生窗口（PrintWindow），1920×1030 下 15 fps，鼠标键盘直接转发
· PC / 手机 / 自适应视口，手机档就是真的 390×844
· 一键封包：Web zip / APK（复用工程自带的 android/ 外壳）/ EXE
· 把工程里的 build:taptap、preflight、release:check 也列出来点一下就运行
· 包体积对照微信/抖音/TapTap 的 4MB 红线
· 二维码，手机扫码真机试玩
· 给 agent 两个工具：截当前帧、读进程日志

零运行时依赖，Windows，MIT。

开源地址：<link>
想听听大家的意见：抓帧用的是 PrintWindow 不是 WGC（这台机器没装 Windows
SDK 的 WinRT 元数据），有人对比过实际效果吗？
```

### 3.4 掘金 — 长文标题

```
《我把 Unity 窗口抓进了 AI 编辑器的侧边栏：一次 15fps 的工程实践》
```

提纲：
1. 问题：AI 写游戏的回路为什么断
2. 为什么 `fetch` 打不通（preload 拦截）→ iframe 桥
3. PrintWindow vs WGC：为什么选了前者
4. 输入转发：坐标归一化与 DPI
5. 侧栏里的"手机"：390×844 到底意味着什么
6. 封包：复用工程自己的 Gradle 外壳
7. 给 agent 装眼睛：截图工具
8. 踩过的坑（渲染 hooks、模块重复注册、Gradle 版本）
9. 数据与结论

### 3.5 X / 即刻 — 短文案

```
把游戏塞进 AI 编辑器的侧边栏了。

Cocos / Godot / Unity 都能抓，15fps，键鼠可直接玩；
顺手能打 Web 包、APK、跑工程里的 build:taptap；
包体积对着 4MB 红线，还有二维码扫码真机试。

零依赖，MIT，Windows。
<link>
```

## 三点五、Discover 索引（已就绪）

仓库里已有 `docs/plugin-index.json`（格式 1，由 `scripts/make-index.mjs` 生成，`scripts/check-index.mjs` 校验）。把这段加到 README 或任何地方，用户就能在 DSH 的 Discover 里添加索引：

```
https://raw.githubusercontent.com/davidmercer0620-ai/dsh-game-preview/main/docs/plugin-index.json
```

每次发版后运行一次：

```bash
node scripts/make-index.mjs && node scripts/check-index.mjs
git commit -am "release: index for vX.Y.Z" && git push
```

## 四、发布后 48 小时做什么

1. **2 小时内回所有评论** —— 早期回复率直接决定算法推不推
2. 有人提 bug → 当天修，并在评论里贴 commit 链接（可信度暴涨）
3. 有人问"支持 macOS 吗" → 老实说 Windows only，并把 roadmap 贴出来
4. star 涨到 100 左右时，发一条「100 stars, here's what I'm building next」的更新
5. 把 3-5 个真实使用场景做成 GIF，第二次发（同样的渠道也能再发一次）

## 五、现实预期

- 单渠道首发：10–50 星（好内容）
- HN 上首页：300–1500 星
- 中文技术圈爆款：100–400 星
- 同时命中 2 个渠道：800–2000 星

1000 星不是"写得好"就能到，是**内容对 + 渠道对 + 时间集中**。这个仓库的内容已经就位（真实数据、零依赖、8 语言、roadmap），剩下的是发布动作。
