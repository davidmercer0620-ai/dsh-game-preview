# Changelog

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
