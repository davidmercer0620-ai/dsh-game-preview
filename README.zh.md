# DSH 游戏预览

**给 DeepSeek Harness 的游戏工作室插件。** 跑起你的游戏，抓取原生引擎窗口，在右侧栏里直接玩——不用切窗口、不用 Alt+Tab。

由 **邮差游戏工作室 / Postman Game Studio** 开发，给用 DSH 做游戏的团队：agent 改代码，面板显示游戏，你的眼睛留在同一个窗口里。

[English](README.md) · **简体中文** · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md)

![右侧栏里的 Unity 原生捕获](docs/images/unity-native-capture.jpg)

*Unity 编辑器实时抓进右侧栏——1920×1030、15 fps，裁到 Game 视图，鼠标键盘可转发。*

## 为什么做它

每个引擎都有最快的那条回路，面板会自动挑：

| 引擎 | 最快回路 | 预览怎么做 |
|---|---|---|
| Cocos Creator | 编辑器浏览器预览（~1 秒） | 连 `localhost:7456`，保留编辑器的 HMR |
| Godot | F5 → 原生窗口（~2 秒） | `godot --path .`，抓窗口 |
| Unity | 编辑器 Play（~3 秒） | `Unity.exe -projectPath`，抓编辑器，并跟随「闪屏 → 编辑器」换窗 |
| 微信小游戏 | 开发者工具构建（~90 秒） | 用微信开发者工具打开工程 |
| Web / 静态 | dev server 或纯文件 | 起脚本，或直接按目录服务 |
| 引擎构建产物 | `build/web-desktop/index.html` | 直接服务导出的包，PC / 手机视口 |

**它永远不问「你用什么引擎」**——检测不到才退回手动 URL。

## 能力

| | |
|---|---|
| **原生窗口捕获** | `PrintWindow` + 抓帧/编码双线程，15–24 fps；「清晰」（原尺寸）或「流畅」（1100px，~24–30 fps） |
| **在面板里玩** | 🖱 把鼠标键盘转发到被抓窗口，含 DPI 校正、F1–F12、方向键与修饰键 |
| **裁到 Game 视图** | ✂ 在画面上框选一块长期只看它，按窗口标题记忆 |
| **PC / 手机 / 自适应** | 真正的 1280×720 与 390×844 逻辑视口，等比缩放——游戏媒体查询看到的是手机 |
| **打开即起播** | 记住每个项目上次的窗口或配置，打开面板自动恢复并运行 |
| **脏改动计数** | 保存不刷新，只显示待运行数量，按 ▶ 或让 agent 重跑 |
| **Agent 工具** | `game_preview_run` / `game_preview_status` / `game_preview_stop` / `game_preview_windows` |
| **快捷键** | `F` 满屏 · `R` 重载 · `Esc` 退出 |

## 安装

要求：DeepSeek Harness `0.2.x`，Node.js 22+。

```bash
# 从本地目录安装（开发，链接安装）
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

或者让 DSH 里的 agent 执行：

```
plugin_manager install_bundle(target: "C:\\path\\to\\dsh-game-preview")
```

装完刷新页面（Ctrl+R）：标题栏出现 ▶，右侧栏「+」里出现 **游戏预览**。

> 原生捕获、输入转发与引擎启动仅支持 **Windows 10/11**；网页预览跨平台可用。

## 用法

1. 打开工作区指向游戏工程的会话
2. 点 ▶（或右侧栏 → **+** → **游戏预览**）
3. 面板自动检测引擎并启动最快回路
4. 改代码——计数显示 `●3`，按 ▶ 或让 agent 调 `game_preview_run`
5. Unity：在编辑器里按一次 Play，用 ✂ 裁出 Game 视图，再点 🖱 直接玩

## 封包

底栏 **📦 导出** 有三个目标，每个都显示就绪状态：

| 目标 | 做什么 | 需要 |
|---|---|---|
| Web 包 | 把构建产物打成 zip 放进 `<项目>/dist` | 什么都不用 |
| Android APK | 跑项目自带的 `android/build.sh`（或 `gradle assembleDebug`），自动注入 `JAVA_HOME` / `ANDROID_HOME` / `GRADLE_BIN` | JDK 17 + Android SDK + Gradle + `android/` 工程 |
| Windows EXE | 构建 Cocos `windows` 平台并复制 exe | VS C++ + CMake + Cocos Creator |

工具链按 Windows 的真实安装位置探测（`JAVA_HOME`、`D:/Android/sdk`、`D:/jdk*`、`%USERPROFILE%/.gradle/wrapper/dists`、`Program Files\\Java`），不只看 `PATH`。

用环境变量选入口的工程可以在 **构建参数…** 里填 KEY=VALUE（例如 `ZAOWU_SRC=index_v5_0.html`），按项目记忆。

## 配置

在 profile 的 `cordis.patch.yml` 里改对应行：

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # 控制 API 起始端口（最多试 16 个）
    captureFps: 20         # 目标抓帧率
    captureWidth: 0        # 编码前缩放；0 = 原尺寸
    captureQuality: 70     # JPEG 质量
    captureWaitMs: 30000   # 等引擎窗口的上限
    godotExe: ''           # 不在 PATH 时填绝对路径
    unityExe: ''           # <版本>\Editor\Unity.exe
    cocosEditor: ''        # CocosCreator.exe
    wechatCli: ''          # 微信开发者工具 cli.bat
```

## 原理

```
DSH Web UI
├── 会话标题栏 ▶                 ──┐
├── 右侧栏 tab「游戏预览」          │ 打开标签
│      ├── 配置条 / 舞台          │
│      └── Playtest Bar          │
└──────────────┬─────────────────┘
               │ iframe 桥（postMessage + 长轮询）
               ▼
Host 插件
├── 同源路由 /api/game-preview/*
├── 回环控制 API 127.0.0.1:7317（兜底）
├── 工作区扫描 + 脏计数
├── 引擎 / dev server 生命周期
├── host/window.js          抓帧桥 + 输入注入
└── host/window-capture.ps1 常驻 C# 助手（DPI 感知、双线程）
```

桌面端页面跑在 `dsh-app://app/`，对回环地址的 `fetch` / `XMLHttpRequest` 会被拦截。所以面板通过 Host 自己提供的隐藏 iframe（`GET /bridge`）通信；不可用时退回同源路由与回环 API。

## 已知限制

- 原生捕获、输入转发、引擎启动仅 Windows
- 独占全屏窗口抓出来是黑的，请改无边框窗口
- 抓帧后端是 `PrintWindow`：4K 窗口原尺寸会掉到 ~10 fps，用「流畅」档
- 输入转发覆盖键鼠（不支持手柄），输入法未处理
- 嵌套工程只扫描一层

## 开发

```bash
node --check index.js && node --check client.js && node --check host/window.js
node scripts/harness.mjs          # Host：控制 API、检测、抓帧、输入、路由
node scripts/client-harness.mjs   # Client：注册与各 UI 状态
```

改 Host 要重装插件；改 Client 刷新页面即可。

## 许可

MIT
