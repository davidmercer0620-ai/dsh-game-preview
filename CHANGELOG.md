# Changelog

## 0.12.0 — 2026-11-10

**一键验收**：`game_preview_check`（工具）/ `POST /api/check`（面板「✓ 自检」按钮）把前面几版的验证能力串成一条命令：

1. 页面自报的报错与帧率
2. 抓一张当前画面（有窗口捕获时）
3. 可选的回放脚本
4. 与上一次自检的**像素对比**
5. 包体积与引擎裁剪建议

结论只有三档：`pass` / `warn` / `fail`，附原因与证据路径；每次的截图自动成为下一次的基线。

实测（炉石传说 web-mobile）：`warn` — 60 fps · 0 错误 · 14 个模块可裁剪 · 各平台体积在预算内。

## 0.11.0–0.11.3 — 2026-11-10

三件验证工具，回答"AI 改了 30 个文件，游戏还能玩吗？"

- **回放**：`game_preview_playtest` / `POST /api/playtest` 按 `{wait, click, key, shot}` 步骤驱动窗口，产出截图 + 期间页面报错
- **视觉对比**：`POST /api/diff` 用 Pillow 比较两帧（默认最近两帧），给出像素变化比例和差异图
- **引擎裁剪**：`game_preview_optimize` / `GET /api/crop` 扫场景/预制体/脚本里的组件用法，列出未使用的 Cocos 功能模块
- 实测（炉石传说）：7 场景、看到 `cc.Vec4×42 / Graphics×31 / cc.Camera×7`、**14 个模块可裁**、引擎包 3.96 MB；两帧对比 **0.1%**

## 0.10.0 — 2026-11-10

Agent 最缺的不是"能操作"，而是"能看见结果"。这一版让被预览的页面自己开口：

- 静态服务在返回 HTML 时注入探针（`/probe.js`）：`window.onerror`、`unhandledrejection`、`console.error`、**资源 404**、以及每 2 秒一次的实测 FPS
- `GET /api/telemetry` 读回环形缓冲；`/api/state` 带一份健康摘要，芯片行显示 `⚠ 3`（红）或 `58fps`
- 新工具 `game_preview_console`：agent 可以直接问"页面报错了没有、跑多少帧"
- 实测：`炉石传说` web-mobile 构建 → **60 fps · 0 错误**

## 0.9.0 — 2026-11-10

接住那位开发者剩下的两条意见：

- **🗂 项目看板**：DSH 认识的所有工作区各一张卡（最新一帧缩略图 + 帧数 + 最后变化时间），点一下就把面板切到那个项目 —— 单屏同时开发多个游戏
- 缩略图接口带包含性检查，只服务列表内的工作区
- **自动记录**：默认开启（`timelineAuto`），仍然是变化门控，间隔从 4 秒放宽到 8 秒；不需要手动点 ⏺
- 实测：5 个工作区、炉石传说 24 帧、缩略图 55 KB 正常下发

## 0.8.0 — 2026-11-09

一位资深开发者的反馈改变了产品方向：**看编辑器直播对 AI 工作流没用**（双屏、agent 后台跑脚本、编辑器只在最后闪一下）。于是改成"结果时间线"：

- **⏺ 结果时间线**：只在画面真变化时存帧（SHA1 门控 + 最少 4 秒间隔），十分钟的 agent 工作变成几张静帧，几百 KB，CPU 几乎为零
- **一键生成 GIF**：直接把延时动图写进工程 `.dsh-game-preview/timeline/timelapse.gif`，可贴进 review/PR
- 帧数上限 200，超出自动淘汰最旧的
- harness 覆盖：时间线开关、帧不足时拒绝生成 GIF

## 0.7.1 — 2026-11-09

- ⌨ 控制台抽屉：dev server / 引擎输出实时显示（1.5s 轮询 `/api/log`）
- **体积口径修正**：以 zip 提交的平台（TapTap）只算提交包，不再把源目录一起累加。实测 TapTap 提交包 **0.64 MB（16%）**，之前的 80.9% 是重复计算的假警报

## 0.7.0 — 2026-11-09

- **体积构成**：点包体积行展开，按目录 / 扩展名 / 单文件列出占比（实测 TapTap 包里 `game.zip` 占 20%）
- **手机预览二维码**：静态预览通过局域网分享（随机 token、30 分钟过期、只服务注册过的目录），宿主用 python-qrcode 生成 PNG，前端零依赖
- **构建历史**：每次导出与工程脚本记录到 `.dsh-game-preview/history.json`，含耗时与体积差值

## 0.6.0 — 2026-11-09

面向游戏开发者的三件事：

- **工程脚本一键执行**：自动列出 `package.json` 里 build/release/verify/bench 类脚本、`android/build.sh`、`build_apk.js`、`tools/build-platform.mjs`，在面板里点一下就跑，输出实时流入日志区
- **包体积预算**：统计 `release/builds/*`、`build/*`、`cocos/build/*` 的体积，对照微信/抖音/TapTap 4 MB 与 web 32 MB 上限，超 80% 标黄
- **Agent 能看画面**：新增 `game_preview_screenshot`（把当前帧存进工程并返回路径，agent 用 read_image 自查）与 `game_preview_logs`（进程输出尾部）

## 0.5.5 — 2026-11-09

封包导出：

- 📦 导出面板：Web zip / Android APK / Windows EXE，带工具链就绪状态
- 工具链探测覆盖 Windows 的真实安装位置（JDK、Android SDK、Gradle wrapper、VS/CMake）
- APK 走项目自带的 `android/` 外壳（`build.sh` 或 `gradle assembleDebug`），自动注入 `JAVA_HOME` / `ANDROID_HOME` / `GRADLE_BIN`
- 构建参数（KEY=VALUE）按项目记忆，例如 `ZAOWU_SRC=index_v5_0.html`
- 进度日志、产物路径与「打开目录」

实测：`F:\造化万物3` 用该流程打出 6.5 MB 的 APK（BUILD SUCCESSFUL，1m20s）。

## 0.5.0 — 2026-11-08

发布准备版本。功能面：

- 原生窗口捕获（`PrintWindow` + 双线程编码），清晰档原尺寸约 15–20 fps，流畅档 1100px 约 24–30 fps
- 输入转发：鼠标移动/左右中键/滚轮，键盘 F1–F12、方向键、常用符号与修饰键；DPI 感知，点击与画面物理像素对齐
- 区域裁剪（✂）：框选窗口里的一块长期只看它（Unity 的 Game 视图），按窗口标题记忆
- PC / 手机 / 自适应三种视口：固定 390×844 与 1280×720 逻辑尺寸并等比缩放，游戏媒体查询看到的是真实设备尺寸
- 满屏模式（⛶ / `F`）、重载（`R`）、退出（`Esc`）
- 打开面板自动恢复上次的窗口或配置，按项目记忆所选配置
- 帧龄 HUD（`24 fps · 42ms`）、面板隐藏时停止解码
- 截图导出（⤓）
- 引擎构建产物检测：`build/<platform>/index.html`（Cocos web-desktop / web-mobile 等）
- Unity：检测 `Assets/` + `ProjectSettings/`，`Unity.exe -projectPath` 启动，闪屏 → 编辑器换窗自动跟随
- Godot：`project.godot`，`godot --path` 跑主场景
- Web：dev/serve/preview 脚本、静态目录服务、单文件打包（非 ES module 时走 blob）

### 传输层

桌面端页面运行在 `dsh-app://app/`，顶层 `fetch` / `XHR` 被 preload 拦截，因此面板通过一个隐藏 iframe 桥（`GET /bridge`）与宿主通信；同源 `/api/game-preview/*` 与回环 `127.0.0.1:7317` 作为后备。帧使用长轮询推送（`/api/frame?since=<seq>`）。

## 0.4.x — 2026-11-08

抓帧稳定性与体验：抓帧重启竞态、引擎换窗跟随、帧推送、自动起播、裁剪、隐藏停解码、输入转发、DPI、键位、画质档、记忆与截图。

## 0.3.x — 2026-11-08

传输与检测修复：同源路由、iframe 桥、空闲会话的工作区发现、嵌套项目与构建产物检测、PC/手机视口。

## 0.2.x — 2026-11-07

原生窗口捕获首个可用版本：`host/window-capture.ps1`、`host/window.js`、`/stream`、窗口选择器、Unity/Godot 启动链路。

## 0.1.0

首个版本：运行配置检测、Playtest Bar、静态文件服务、脏改动计数、三个 agent 工具、右侧栏 tab。
