# dsh-game-preview

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的游戏预览面板：**右侧栏一个舞台 + 一条 Playtest Bar**，按引擎选最快的回路，改完再跑，不用切窗口。

> 面向游戏开发的迭代循环：改代码 → 跑起来 → 玩一下 → 看指标 → 再改。
> 不是"浏览器预览器"，是游戏运行台。

## 现在能做什么

| 能力 | 说明 |
|---|---|
| 右侧栏舞台 | 会话旁边一个可拖宽的预览面板，Web 预览支持 100% / 768px / 375px 三档宽 |
| 运行配置自动检测 | 扫工作区**和一层子目录**识别 Cocos Creator、微信小游戏、Godot、Unity、Node dev server（dev/start/serve/preview）、静态 HTML |
| 自动定位工作区 | 面板没有会话上下文时，Host 从活着的 Agent 借当前工作目录；多个会话时标题栏的 `📁` 可切换 |
| **原生窗口捕获** | Godot / Unity 的原生窗口直接进舞台：`PrintWindow` 抓帧 + 双线程编码，15–24 fps（可切「清晰 / 流畅」），局部脏帧自动丢弃 |
| **直接在面板里玩** | 🖱 操作模式把鼠标/键盘转发到窗口（含 DPI 校正与按键映射），Esc 退出 |
| **Game 视图裁剪** | ✂ 框选任意区域只看那一块（Unity 的 Game 视图），按窗口标题记忆 |
| **打开即起播** | 记住每个项目上次用的配置与窗口，开面板自动恢复；也可关掉自动运行 |
| 任意窗口接入 | 面板上的「选择窗口」可以把任何已在运行的窗口接进舞台（不只是游戏） |
| 脏改动计数 | 保存**不刷新**，面板显示 `● N 处改动待运行`，按 ▶ 或让 agent 跑才重新加载 |
| Playtest Bar | 运行 / 重载 / 停止 / 切换宽度 / 外部打开 |
| 静态目录服务 | `/static/<root>/…` 按目录服务整包，`main.js`、贴图、字体、wasm 的相对路径都能加载，不受 `file://` 限制 |
| Agent 工具 | `game_preview_run` / `game_preview_status` / `game_preview_stop` / `game_preview_windows` |
| 画质档位 | 清晰（原尺寸 ~15–20 fps）/ 流畅（1100px ~24–30 fps），切换即重挂抓帧 |
| 快捷键 | `F` 满屏、`R` 重载、`Esc` 退出满屏/操作模式 |

## 现在还不能做什么（v0.2 的边界）

- **原生窗口只给人看，不能操作**：键盘/鼠标转发（PR2）还没做，舞台里的窗口只是画面。要玩请点进窗口本身。
- **套装引擎要先自己跑起来**：Unity 只负责拉起编辑器，**Play 要手动按一次**；Godot 直接跑主场景（等价 F5）。
- **独占全屏抓不到**：`PrintWindow` 对独占全屏返回黑帧，面板会提示切无边框窗口，不会装死。
- **微信小游戏**：只负责调起开发者工具，还没接 `miniprogram-automator` 的截图与脚本输入。
- **没有暂停 / 单步 / 截图 / 录制回放**：这些要往游戏循环里打 hook，排在 v0.3。
- **窗口捕获只支持 Windows**（`PrintWindow` + DWM 合成）。

## 安装

要求：DeepSeek Harness `0.2.x`（Web 或桌面），Node.js 22+。窗口捕获另需 Windows 10/11。

```bash
# 从本地目录安装（开发用；目录是链接安装）
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

或者在 DSH 里让 agent 执行：

```
plugin_manager install_bundle(target: "C:\\\\path\\\\to\\\\dsh-game-preview")
```

装完**刷新页面**（Ctrl+R）：会话标题栏右侧出现一个 ▶ 图标，右侧栏的「+」里出现「游戏预览」卡片。

## 使用

1. 打开一个游戏项目所在的会话。
2. 点标题栏的 ▶ 图标，或右侧栏 →「+」→「游戏预览」。
3. 顶部是自动检测出的运行配置，点一个就启动。
4. 改代码，面板顶部出现 `● N 处改动待运行`；按 ▶ 运行，或让 agent 调 `game_preview_run`。
5. 底部条：`▶ 运行` / `⟳ 重载` / `⏹ 停止` / 宽度三档 / `↗ 外部`。
6. 原生窗口：点配置后引擎被拉起，窗口出现即开始抓帧；左上角显示 `24 fps · 1280×720`。

### Agent 工具

| 工具 | 作用 |
|---|---|
| `game_preview_run` | 启动或刷新预览，返回 URL、耗时、错误；`window` 参数可指定 hwnd 或标题片段 |
| `game_preview_windows` | 列出这台机器上可捕获的窗口（hwnd / pid / 尺寸 / 标题） |
| `game_preview_status` | 读检测到的配置、当前 URL、是否在跑、抓帧 fps、有哪些脏改动 |
| `game_preview_stop` | 停掉预览启动的进程（`taskkill /T`）和抓帧助手 |

典型用法：改完 `game.js` 之后直接调 `game_preview_run`，用户立刻能玩到新版本。

## 检测规则

扫描范围：**工作区根目录 + 一层子目录**（游戏工程经常是「微信壳 + `cocos/` 真工程」这种结构）。

| 命中条件 | 配置 | 行为 |
|---|---|---|
| `settings/` + `assets/`（或 `settings/v2`） | Cocos · Web | 连 `http://localhost:7456`（编辑器预览，自带 HMR） |
| `project.config.json` + `game.json` | 微信小游戏 | 调开发者工具 `cli.bat open --project` |
| `project.godot` | Godot · 原生 | `godot --path .` 跑主场景 + 窗口捕获 |
| `Assets/` + `ProjectSettings/` | Unity · 原生 | 拉起 `Unity.exe -projectPath` + 窗口捕获（Play 需手动） |
| `package.json` 有 `dev` / `start` / `serve` / `preview` | Web · dev server | 跑脚本并等端口；端口从脚本参数或它执行的 `.mjs` 里读 |
| 目录里有 `index.html` | 静态 HTML | `/static/<root>/` 目录服务 |

**永远不问"你用什么引擎"**：检测不到才退回「手动 URL」。

## 配置

在 profile 的 `cordis.patch.yml` 里改这一行的 `config`：

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # 控制 API 起始端口，被占用时自动往后找
    waitForMs: 60000       # 等 dev server 就绪的上限
    wechatCli: ""          # 微信开发者工具 cli.bat 的绝对路径，留空则自动找常见路径
    cocosEditor: ""        # CocosCreator.exe 的绝对路径
    godotExe: ""           # Godot 可执行文件；留空则扫 PATH
    unityExe: ""           # <版本>\Editor\Unity.exe；留空则用 Unity Hub 的安装目录
    captureFps: 20         # 抓帧目标帧率（1–60）
    captureWidth: 0        # 缩放后的最大宽度，0 = 原尺寸（缩放会明显增加 CPU）
    captureQuality: 70     # JPEG 质量（10–95）
    captureWaitMs: 30000   # 等游戏窗口出现的上限
    allowedOrigins: []     # 额外允许的页面来源；默认只认 loopback
```

## 它是怎么跑起来的

```
Harness Web UI（已登录）
├── 会话标题栏 ▶ 图标 ─────────────┐
├── 右侧栏 tab「游戏预览」          │  openTab('game-preview')
│     ├── 配置条 / 舞台            │
│     │     ├── <iframe>  ← Web 预览
│     │     └── <img>     ← /stream（原生窗口）
│     └── Playtest Bar             │
│            │ fetch                │
└────────────┼──────────────────────┘
             ▼
Host 插件（零依赖）
├── 控制 API  http://127.0.0.1:7317/api/*
│     ├── /hello  /state  /detect  /run  /stop  /clean  /log
│     ├── /window/list  /window/attach  /window/stop
│     ├── /roots   活着的会话目录（面板 📁 切换用）
│     ├── /static  静态目录服务（相对路径不丢）
│     ├── /frame   最近一帧 JPEG（轮询用）
│     ├── /stream  multipart/x-mixed-replace（<img> 直接用）
│     └── /file  静态单页服务（realpath 包含性校验）
├── 工作区扫描 + fs.watch 脏计数（跳过 node_modules/dist/build 等）
├── dev server / 引擎子进程管理（启动、等窗口/端口、退出捕获、日志尾）
├── host/window.js       抓帧桥：行协议 → Promise + 帧流 + 健康指标 + 输入注入
└── host/window-capture.ps1  常驻 PowerShell 助手（C# 抓帧/双线程流水线/DPI 感知/SendInput）
```

Client 与 Host 之间有两条通道，**面板优先走同源**：

- **同源 `/api/game-preview/*`**（首选）：Host 用 `ctx.connection.fetch.register` 挂上 11 条路由，面板用相对地址请求。桌面端页面是 `file://`、fetch 走 IPC 桥，只有这条能通。
- **loopback `127.0.0.1:7317`**（兜底）：Host 自建的 HTTP 控制服务，Web 端和命令行 curl 用；面板探测 7317–7332 认领。

两条通道共用同一套处理逻辑，HTTP 只是外壳。

### 抓帧为什么用 PowerShell 助手

`Windows.Graphics.Capture`（WGC）需要 WinRT + D3D11 互操作；先用 `PrintWindow(PW_RENDERFULLCONTENT)` 拿到 DWM 合成后的窗口画面，实测足够：

| 窗口 | 抓帧 | 编码 | 流水线后 |
|---|---|---|---|
| Chrome 1691×995（D3D 合成） | 31 ms | 17 ms JPEG q70 | **25.4 fps**，97 KB/帧 |
| 记事本 1288×723 | ~20 ms | ~10 ms | 16 fps |

单线程串行只有 12.6 fps；`window-capture.ps1` 里抓帧线程和编码线程是分开的，编码忙时丢旧帧（`drops` 计数）。助手是常驻子进程，一个进程同时服务枚举、抓帧和健康状态，崩溃后自动重启一次。

## 安全模型

- 控制 API 只绑 `127.0.0.1`，不监听局域网。
- CORS 只回显允许的来源（loopback 或 `allowedOrigins`），其余来源直接 403；不再回显任意 Origin。
- 自定义请求头 `x-game-preview` 强制预检，挡住无预检的简单请求 CSRF。
- 静态文件服务做 realpath 前缀校验，`..` 与越界路径返回 403。
- 窗口捕获只在用户/agent 显式选择后启动，助手不扫描屏幕、不抓本进程以外的隐藏窗口。

## 已知限制

- 端口探测只覆盖 16 个端口，全被占用时面板会提示"宿主未响应"。
- 同时开着多个会话时，面板默认借**最近创建**的那个会话目录；轮到别的项目请点 `📁` 切换（页面 URL 带会话 id 时会自动匹配）。
- 只扫一层子目录：`a/b/cocos` 这种两层嵌套要手动填路径。
- 抓帧是 CPU 读回 + JPEG 编码：4K 窗口会掉到 5–8 fps；`captureWidth` 缩到 1280 能明显提速。
- 独占全屏 / 最小化窗口抓不到，面板给的是提示而不是黑屏。
- 编辑器路径（Cocos / 微信 cli / Godot / Unity）默认按常见位置猜，装到非默认盘要显式配置。
- 窗口捕获的输入转发只覆盖键盘与鼠标（无手柄），F1–F12 与常用键已映射，输入法/中文输入未处理。
- 抓帧后端仍是 `PrintWindow`：4K 窗口 + 原尺寸会掉到 10 fps 左右，切「流畅」能到 24–30。

## Roadmap

- **v0.2**（本版）：窗口捕获 + 生命周期（窗口匹配、断流检测、崩溃重启、降级文案）
- **v0.2.1**：输入转发（键盘/鼠标 → 目标窗口，带前台校验）
- **v0.3**：录制与回放（seed + 输入序列），同一段输入对比两个 build；暂停/单步/截图
- **v0.4**：微信 `miniprogram-automator` 通道（截图 / 脚本输入 / console 捕获）
- 之后：引擎桥（Godot TCP 6007、Unity Editor 连接）、WGC 抓帧后端

## 开发

```bash
node --check index.js && node --check client.js && node --check host/window.js
node scripts/harness.mjs          # Host：控制 API、检测、启动、静态服务、脏计数、工具、真实窗口抓帧
node scripts/client-harness.mjs   # Client：模块注册、tab 类型、两个槽位、web/窗口两种舞台、断流提示、窗口选择器
```

两个 harness 都不需要 Harness 进程，改完先跑它们。`harness.mjs` 会真的开一个记事本窗口抓帧，跑完自动关掉。

**改完 Host 要重装才生效**（模块已经 import 进进程了）：

```
plugin_manager remove_bundle(target: "dsh-game-preview")
plugin_manager install_bundle(target: "<绝对路径>")
```

Client 只要刷新页面。

## License

MIT
