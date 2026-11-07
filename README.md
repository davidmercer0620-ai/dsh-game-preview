# dsh-game-preview

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的游戏预览面板：**右侧栏一个舞台 + 一条 Playtest Bar**，按引擎选最快的回路，改完再跑，不用切窗口。

> 面向游戏开发的迭代循环：改代码 → 跑起来 → 玩一下 → 看指标 → 再改。
> 不是"浏览器预览器"，是游戏运行台。

## 现在能做什么

| 能力 | 说明 |
|---|---|
| 右侧栏舞台 | 会话旁边一个可拖宽的预览面板，支持 100% / 768px / 375px 三档宽 |
| 运行配置自动检测 | 扫工作区识别 Cocos Creator、微信小游戏、Godot、Unity、Node dev server、静态 HTML |
| 脏改动计数 | 保存**不刷新**，面板显示 `● N 处改动待运行`，按 ▶ 或让 agent 跑才重新加载 |
| Playtest Bar | 运行 / 重载 / 停止 / 切换宽度 / 外部打开 |
| 本地文件服务 | 单页 HTML 游戏直接从内置 loopback 服务加载，不受 `file://` 限制 |
| Agent 工具 | `game_preview_run` / `game_preview_status` / `game_preview_stop`，改完由模型自己拉起预览 |

## 现在还不能做什么（v0.1 的边界）

- **Godot / Unity 只识别不运行**：原生窗口捕获排在 v0.2。当前会在配置条里显示为灰色。
- **没有暂停 / 单步 / 截图 / 录制回放**：这些需要往游戏循环里打 hook，v0.2 一起做。
- **微信小游戏**：只负责构建产物的打开（调 `cli.bat open --project`），还没接 `miniprogram-automator` 的截图与脚本输入。
- **没有 WebGL 导出**：Unity 的网页路线不叫预览，本项目不做。

## 安装

要求：DeepSeek Harness `0.2.x`（Web 或桌面），Node.js 22+。

```bash
# 从本地目录安装（开发用；目录会有 HMR 链接）
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

或者在 DSH 里让 agent 执行：

```
plugin_manager install_bundle(target: "C:\\path\\to\\dsh-game-preview")
```

装完**刷新页面**（Ctrl+R）：会话标题栏右侧出现一个 ▶ 图标，右侧栏的「+」里出现「游戏预览」卡片。

## 使用

1. 打开一个游戏项目所在的会话。
2. 点标题栏的 ▶ 图标，或右侧栏 →「+」→「游戏预览」。
3. 顶部是自动检测出的运行配置，点一个就启动。
4. 改代码，面板顶部出现 `● N 处改动待运行`；按 ▶ 运行，或让 agent 调 `game_preview_run`。
5. 底部条：`▶ 运行` / `⟳ 重载` / `⏹ 停止` / 宽度三档 / `↗ 外部`。

### Agent 工具

| 工具 | 作用 |
|---|---|
| `game_preview_run` | 启动或刷新预览，返回 URL、耗时、错误；在会话的工作目录里执行 |
| `game_preview_status` | 读检测到的配置、当前 URL、是否在跑、有哪些脏改动 |
| `game_preview_stop` | 停掉预览启动的进程 |

典型用法：改完 `game.js` 之后直接调 `game_preview_run`，用户立刻能玩到新版本。

## 检测规则

| 命中条件 | 配置 | 行为 |
|---|---|---|
| `settings/` + `assets/` | Cocos · Web | 连 `http://localhost:7456`（编辑器预览，自带 HMR） |
| `project.config.json` + `game.json` | 微信小游戏 | 调开发者工具 `cli.bat open --project` |
| `project.godot` | Godot · 原生 | v0.2（仅识别） |
| `ProjectSettings/` + `Assets/` | Unity · 原生 | v0.2（仅识别） |
| `package.json` 有 `dev`/`start` | Web · dev server | 跑脚本并等端口 |
| 根目录有 `index.html` | 静态 HTML | 内置 loopback 文件服务 |

**永远不问"你用什么引擎"**：检测不到才退回「手动 URL」。

## 配置

在 profile 的 `cordis.patch.yml` 里改这一行的 `config`：

```yaml
- id: dsh-game-preview
  config:
    port: 7317          # 控制 API 起始端口，被占用时自动往后找
    waitForMs: 60000    # 等 dev server 就绪的上限
    wechatCli: ""       # 微信开发者工具 cli.bat 的绝对路径，留空则自动找常见路径
    cocosEditor: ""     # CocosCreator.exe 的绝对路径；填了就能替你启动编辑器
```

## 它是怎么跑起来的

```
Harness Web UI (:53948, 已登录)
├── 会话标题栏 ▶ 图标 ─────────────┐
├── 右侧栏 tab「游戏预览」          │  openTab('game-preview')
│     ├── 配置条 / 舞台 iframe      │
│     └── Playtest Bar             │
│            │ fetch                │
└────────────┼──────────────────────┘
             ▼
Host 插件（零依赖）
├── 控制 API  http://127.0.0.1:7317/api/*
│     ├── /hello  /state  /detect  /run  /stop  /clean  /log
│     └── /file  静态单页服务（realpath 包含性校验）
├── 工作区扫描 + fs.watch 脏计数（跳过 node_modules/dist/build 等）
├── dev server 子进程管理（启动、等待端口、退出捕获、日志尾）
└── 三个 agent 工具
```

Client 与 Host 之间**不依赖任何 Harness 内部 API**：面板探测 7317–7332 端口，找到自己的 Host 就位（`/api/hello` 认领）。因此 DSH 大版本升级时，插件里没有会碎的私有契约。

## 安全模型

- 控制 API 只绑 `127.0.0.1`，不监听局域网。
- CORS 只回显 DSH 自己的 origin；跨站请求拿不到响应。
- 自定义请求头 `x-game-preview` 强制预检，挡住无预检的简单请求 CSRF。
- 静态文件服务做 realpath 前缀校验，`..` 与越界路径返回 403。
- 预览页面跑在 dev server 自己的 origin 上，读不到 Harness 的存储和认证 API。

## 已知限制

- 端口探测只覆盖 16 个端口，全被占用时面板会提示"宿主未响应"。
- 控件 `ifconfig` 级别的窗口捕获、暂停/单步、截图回传都还没有。
- 编辑器路径（Cocos / 微信 cli）目前靠常见路径猜测，装到非默认盘需要显式配 `wechatCli`。
- 面板宽度、设备档位不持久化，刷新后回到默认。

## Roadmap

- **v0.2**：窗口捕获（Godot / Unity 的编辑器 Play 窗口）+ 暂停 / 单步 / 截图。
- **v0.3**：录制与回放（seed + 输入序列），同一段输入对比两个 build。
- **v0.4**：微信 `miniprogram-automator` 通道（截图 / 脚本输入 / console 捕获）。
- 之后：引擎桥（Godot TCP 6007、Unity Editor 连接）。

## 开发

```bash
node --check index.js && node --check client.js
node scripts/harness.mjs          # Host：控制 API、检测、启动、静态服务、脏计数、三个工具
node scripts/client-harness.mjs   # Client：模块注册、tab 类型、两个槽位、舞台与脏标记渲染
```

两个 harness 都不需要 Harness 进程，改完先跑它们。

## License

MIT
