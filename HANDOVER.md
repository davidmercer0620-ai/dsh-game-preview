# 交接说明 · dsh-game-preview v0.1

这份文档是给你回家继续开发用的。读完应该能：装上、跑起来、知道代码在哪、知道哪里没做完、知道哪些坑我已经踩过。

---

## 1. 它是什么，现在到哪一步

DSH 的**游戏预览面板**：右侧栏一个舞台，按引擎选最快的回路跑起来，改完不自动刷（脏计数 + 按需运行），并给 agent 三个工具让它自己拉起预览、看状态、停进程。

**已验证（我在这台机器上跑过、有输出）**

| 项 | 证据 |
|---|---|
| Host 控制 API 活着 | `:7317/api/hello` → `{ok:true,app:"dsh-game-preview",tools:3}` |
| 三个工具进了模型工具表 | `Tool.listTools` 里能读到 `game_preview_run / status / stop` |
| 静态 HTML 预览 | `/api/detect` → `static`，`/api/run` → URL，`/api/file` → 200 |
| 真实 dev server 生命周期 | `npm run dev` 拉起 → 420ms 就绪 → stop 后端口关闭 |
| Cocos / 微信 检测 | `cocos-web@http://localhost:7456`、`wechat`（缺 cli 时报可执行错误） |
| Client 注册与渲染 | 离线 harness：tab 类型、两个槽位、iframe、脏标记全部命中 |

**没验证（只能你看）**

- 浏览器里 ▶ 图标真出没出、右侧栏面板长什么样。我没有浏览器控制能力。

**没做（v0.2+）**

- Godot / Unity 原生窗口捕获（设计已写：`docs/v0.2-window-capture.md`）
- 暂停 / 单步 / 截图 / 录制回放
- 微信 `miniprogram-automator`（现在只负责调起开发者工具）

---

## 2. 怎么装到另一台机器

要求：DeepSeek Harness `0.2.x`，Node 22+。

```powershell
# 解压后，把绝对路径交给 DSH 的 agent，或直接在 UI 里 Plugins → Add → 本地目录
plugin_manager install_bundle(target: "D:\\dsh-game-preview")
```

装完 **Ctrl+R 刷新页面**。标题栏右侧出现 ▶，右侧栏「+」里出现「游戏预览」。

> 目录安装是**链接**安装：移动或删除目录后要重新装一次。

---

## 3. 目录结构

```
dsh-game-preview/
├── package.json          # dsh.bundle.patch + dsh.client（platform/immediately/inject）
├── cordis.patch.yml      # 插入一行插件，config: port / waitForMs / wechatCli / cocosEditor
├── index.js              # Host：检测、进程、watch、控制 API、三个工具
├── client.js             # Client：注册 tab 类型 + 面板组件 + 标题栏按钮
├── locale/{en,zh}.json   # meta.title / meta.description（插件卡片显示用）
├── icon.svg              # 自绘图标
├── examples/catch-stars/ # 一个能跑的最小 HTML5 游戏，用来验收
├── scripts/harness.mjs       # Host 桩测试（检测/启动/静态服务/脏计数/工具/进程树）
├── scripts/client-harness.mjs# Client 冒烟测试（模块注册/槽位/渲染树断言）
├── docs/v0.2-window-capture.md
└── README.md
```

---

## 4. 架构（两句话）

- **Host** 自己起一个 `127.0.0.1:7317` 的 HTTP 控制服务，Client 通过探测 7317–7332 端口找到它。**没有用 DSH 的内部 RPC**，所以升级不易碎。
- **Client** 向 `sidebarRightTabs` 注册一个 tab 类型，body 渲染进 `sidebar.right.pane.tab` 槽位；标题栏按钮注册进 `conversation.session.header.utilities`。

两者唯一耦合是 HTTP + JSON，改一边不会炸另一边。

---

## 5. 我踩过的坑（省你几小时）

**1. `ctx.tools` 默认不存在。**
Host 插件要 `export const inject = ['tools']`，否则 `ctx.tools.register` 直接 TypeError。我当时用 try/catch 吞了异常，结果工具静默消失，查了很久。**教训：不要吞注册异常，至少 console 出来。**

**2. 右侧栏不是"塞个 iframe"，是 tab 系统。**
真正的注册路径（我是从已安装的 `dsh-context` 里反向读出来的，比文档快）：

```js
ctx.inject(['sidebarRightTabs'], (inner) => {
  inner.sidebarRightTabs.register({ id, kind, title: () => '…', guide: [{ order, title, description }] })
  inner.slots.inject('sidebar.right.pane.tab', () =>
    inner.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body))
})
```

打开面板：`ctx.get('sidebarRight').openTab(KIND)`。
面板标题可另注册 `sidebar.right.pane.tab.title`（我不注册，用 open 时捕获的 title）。

**3. 不要 import Harness 的 Client 包。**
`@deepseek-ai/dsh-client-ui-primitives` 这类会随版本变；`dsh.client.inject` 里的条目只用来排序激活，不是可 import 的模块。控件自己写，样式只依赖 `--dsw-alias-*` token。

**4. 权限：`ctx.get(name)` 比 `inject` 更宽容。**
`webServer`、`sidebarRight` 这类我都是 `ctx.get()` + 判空，缺了不影响插件激活。

**5. Windows 上杀进程要杀树。**
`npm run dev` 是 cmd 的子进程，`child.kill()` 会留下孤儿 node 占着端口。用：
```js
execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
```

**6. `fs.watch(recursive)` 会报目录事件。**
同一次保存会给你 `src/game.js` 和 `src` 两条，必须 `statSync` 过滤目录，否则脏计数虚高。

**7. DSH 装在 `app.asar` 里，ripgrep / glob 读不了。**
只有 `read` 工具能读。要查包名，我是用 Node 手撕 asar 头的：

```js
// asar: [4][payloadSize][stringSize][pad] + JSON
const hs = header.readUInt32LE(8)
```

**8. 控制 API 用自建 loopback，而不是 `ctx.webServer.register`。**
后者我不知道确切 route 形状（`lib/types` 没随包发布），试错成本高。自建 HTTP 反而更稳：CORS 只回显 DSH 的 origin，自定义头 `x-game-preview` 强制预检。

**9. 端口不能写死。**
7317 被占时自动往后找 16 个；Client 依次探测，用 `/api/hello` 认领。所以同时装两个实例也不会抢端口失败。

---

## 6. 怎么跑测试

```powershell
node --check index.js
node --check client.js
node scripts/harness.mjs           # Host 全链路，约 5 秒
node scripts/client-harness.mjs    # Client 注册 + 渲染，毫秒级
```

`harness.mjs` 里有五个场景：静态页、Cocos（超时文案）、微信（缺 cli 文案）、node-dev（真实拉起+停止）、脏计数。

**改完 Host 要重装才生效**（模块已经 import 进进程了）：
```
plugin_manager remove_bundle(target: "dsh-game-preview")
plugin_manager install_bundle(target: "<绝对路径>")
```
Client 只要刷新页面。

---

## 7. 下一步建议（按性价比）

1. **先确认面板能画出来**（Ctrl+R → ▶ 图标）。这一步不过，别的都免谈。
2. **发布**：`git remote add origin <空仓库>` + `git push -u origin main`。包名想改 scope 就现在改（`package.json` + `cordis.patch.yml` + `client.js` 里的 `id` 三处）。
3. **v0.2 窗口捕获**：按 `docs/v0.2-window-capture.md` 拆的三个 PR 做，PR1（能看不能玩）就能单独发版。
4. 微信 `miniprogram-automator`：先花半天实测小游戏到底能不能截图/执行脚本，**不通就别做**，降级成窗口捕获。

---

## 8. git 历史

```
5 个 commit，工作区干净
1989873 docs: v0.2 native window capture design
07cc051 fix: kill the whole dev-server process tree; test the real dev-server lifecycle
7d84b30 feat: actionable Cocos start-up error and optional editor launch
90cc40d test: client registration harness + engine detection fixtures
e890ab5 feat: game preview panel for DeepSeek Harness (v0.1)
```

`.git` 在归档里，`git log` 可以直接看。

---

## 9. 排障

| 现象 | 先查什么 |
|---|---|
| 面板「宿主未响应」 | Host 没激活：`curl http://127.0.0.1:7317/api/hello`；没响应就看插件是否 enabled |
| 图标不出现 | F12 console 搜 `slot entry crashed`；那是 Client 组件抛错 |
| 点了运行没反应 | 面板顶部有没有配置？没有就在输入框填项目目录点「检测」 |
| 端口全被占 | 改 `cordis.patch.yml` 的 `port` |
| 装了却没生效 | 目录安装是链接，改 Host 代码后要 remove + install |

---

有任何一步和文档不一致，以**代码**为准，文档可能落后。改动后麻烦顺手更新这一份。

---

## 10. 2026-11-07 续开发（v0.2.0）

这一轮在接手机器上做完了 v0.2 的 **PR1 抓帧** 和 **PR3 生命周期**，PR2 输入转发仍未做。

### 做了什么

| 改动 | 文件 |
|---|---|
| 常驻抓帧助手（C# + 双线程流水线，行协议） | `host/window-capture.ps1` |
| 抓帧桥：行协议 → Promise / 帧流 / 健康指标 / 崩溃重启一次 | `host/window.js` |
| Godot / Unity 原生配置从「仅识别」变成真能跑：`godot --path`、`Unity.exe -projectPath` | `index.js` |
| 新增 `/stream`（multipart）、`/api/frame`、`/api/window/list`、`/api/window/attach`、`/api/window/stop` | `index.js` |
| 第四个工具 `game_preview_windows`；`game_preview_run` 新增 `window` 参数 | `index.js` |
| 面板舞台支持 `<img>` 抓帧、fps/断流/黑帧角标、「选择窗口」下拉、宽度持久化 | `client.js` |
| 修：CORS 回显任意 Origin、`/api/detect` 无 root 时 500、`capture.supported` 用错成实例属性 | `index.js` |
| harness 增加真实窗口抓帧、原生启动、缺引擎、CORS、detect 守卫五组断言 | `scripts/*.mjs` |

### 验证到了什么（都在本机跑过）

```
node scripts/harness.mjs         → exit 0
  记事本窗口 1288×723：attach → frame 200 / JPEG ffd8ff / fps 16.1 / stream multipart 正常
  关窗后 → errorCode=window-closed（3 秒内）
  原生路径（project.godot + 替身 exe）→ 418ms 找到窗口，抓帧 15.7 fps，stop 后抓帧停
  缺引擎 → 报错点名 godotExe
  CORS：https://evil.example → 403；http://127.0.0.1:56543 → 200
node scripts/client-harness.mjs  → exit 0（web 舞台 / 窗口舞台 / 断流角标 / 窗口选择器都渲染）
```

实测帧率：Chrome 1691×995 → **25.4 fps**（抓帧 31ms + 编码 17ms 并行，97KB/帧，0 掉帧）。串行实现只有 12.6 fps，流水线是这版的关键。

### 没验证的（诚实清单）

- **Godot**：本机没装，`godot --path` 只在机制层用替身 exe 验证过。
- **Unity**：本机有 6000.6.7f1，但没跑真实工程。拉起 → 找窗 → 抓帧的机制是同一条路径；Play 仍需手动按一次（没有编辑器脚本时的已知限制）。
- **浏览器里的面板**：装完要手动 Ctrl+R；`slots` 检查工具在本会话里传参有 bug，只能靠 client-harness 断言 + 你刷新后肉眼确认。

### 这轮踩的坑（省你几小时）

1. **PowerShell 5.1 的 `Add-Type` 只认 C# 5**：`?.`、字符串插值、`nameof` 全不能编译。报错会指到 `Add-Type` 而不是具体语法。
2. `Add-Type -CompilerOptions` 在 5.1 不存在（是 `-CompilerParameters`）。所以别用 `unsafe`，`LockBits` 后用 `Marshal.Copy` 拷出来采样。
3. `EncoderParameter.Value` 在 .NET Framework 里不能赋值，改成每次新建 `EncoderParameter`。
4. `CreateCompatibleBitmap(IntPtr.Zero, …)` 得到的是 1bpp 单色位图 —— 会报 "A generic error occurred in GDI+"。要传屏幕 DC。
5. GDI+ 的 `HALFTONE` StretchBlt 极慢（1691→1600 要 208ms），别用它缩放；`InterpolationMode.Bilinear` 也要 30–50ms。**能不缩放就不缩放**。
6. `PrintWindow(PW_RENDERFULLCONTENT)` 对窗口化的 D3D 应用（Chrome/Unity）能抓到真实画面，包括后台窗口；独占全屏才是黑。
7. 抓帧 31ms + 编码 17ms 串行只有 12.6 fps，拆成两个线程后 25.4 fps。编码线程忙就丢旧帧，别排队。
8. 这台机器没有 7z/无 LZMA 的 bsdtar：用 `python -c "import py7zr; py7zr.SevenZipFile(...).extractall('.')"` 解包。
9. `ops_*` 写文件在本会话被 `PUBLICATION_DENIED` 拒了，改用内置 `write`/`edit`。

### 下一步（按性价比）

1. **PR2 输入转发**：`SendInput` + 前台校验；不做的话舞台永远是"只能看"。
2. **真实引擎回归**：装个 Godot 4（免安装 zip 即可）跑 `--path`，Unity 拿个小工程试 `-projectPath` + Play。
3. **WGC 后端**：只换 `window-capture.ps1` 内部，协议不动；判定阈值已在文档里写好。
4. 发布：`git remote add origin <空仓库>` + `git push -u origin main`。

---

## 11. 2026-11-07 修复：面板"没检测到项目"（v0.2.1）

### 现象

在 `F:\炉石传说` 和 `F:\降维联盟` 两个项目里开面板，都显示"未检测到项目"。

### 根因（两个叠在一起）

1. **面板根本不知道工作区**。Host 只在 `game_preview_*` 工具被调用时通过 `ctx.workingDirectory.get(agent)` 学到目录；用户直接点开会话标题栏的 ▶ 时 `state.lastRoot` 是 null，`/api/state` 返回空 configs，面板就渲染 "未检测到项目"——跟项目结构无关。
2. **检测只看根目录，且只认 dev/start**。`F:\炉石传说` 根是微信小游戏壳，真工程在 `cocos/`、`cozy-tower-idle-main/`；`F:\降维联盟` 的脚本叫 `serve`，旧代码只认 `dev`/`start`。

### 干了什么

| 改动 | 位置 |
|---|---|
| 自动发现工作区：`agents.roots()` → `workingDirectory.get(session)`，按会话创建时间取最近的；页面 URL 带会话 id 时优先用它 | `index.js` `discoverRoot()` |
| `/api/roots` 列出活着的会话目录；面板顶栏 `📁 <目录> ▾` 可切换，多会话不再靠猜 | `index.js` / `client.js` |
| 检测扩到**根 + 一层子目录**，每个配置带 `dir`，启动/静态服务都在子目录里跑 | `index.js` `configsAt()` |
| 脚本名扩到 `dev`/`start`/`serve`/`preview`，端口从 `--port`、`PORT=` 或它执行的 `.mjs` 里读 | `index.js` `pickScript()` / `guessDevUrl()` |
| 静态页从 `/file?path=` 换成 `/static/<base64url root>/<rel>`，**相对路径不再丢**（`main.js`/贴图/wasm 都能加载） | `index.js` |
| 静态路由只服务注册过的目录（403 挡掉任意盘符读取） | `index.js` |
| 版本号改为从 `package.json` 读（之前 `hello` 永远显示 0.2.0） | `index.js` |

### 验证

```
F:\炉石传说  → wechat（根） + cocos-web@cocos + cocos-web@cocos-creator-3.8-template-master + cocos-web@cozy-tower-idle-main
F:\降维联盟  → node-dev（npm run serve） + static@web
无 root 调 /api/state → root=F:\降维联盟（自动发现），configs 立即出现
/static/…/web/index.html 200 872B，相对路径 main.js 200 5383B、render.js 200 7214B
harness：嵌套检测、serve 端口解析、相对资源、未注册 root 403 全绿
```

### 仍要注意

- `F:\降维联盟` 的 `npm run serve` 指向 `tools/serve.mjs`，**这个文件现在不存在**（web/ 是直接静态页），所以真正的开发回路目前是 `static@web`；等 serve.mjs 写出来，端口会被自动读出来。
- 微信小游戏仍然只负责调起开发者工具，本机没装 cli。

---

## 12. 2026-11-08 真因：桌面端跨端口 fetch 根本不通（v0.2.3）

### 现象

面板一直"没检测到"，但 Host 用 curl 查一切正常。

### 证据链

1. 面板打开着，Host 的请求日志里 **0 条记录**——浏览器侧一次都没发出请求。
2. 读 `@deepseek-ai/dsh-host-webserver` 的 README 第一段：

   > It serves browsers only; **Electron loads dist over `file://` and carries fetch over an IPC bridge.**

3. 反编译 `dsh-context`（同机已装）的客户端，全部请求都是**同源相对路径** `fetch('/api/dsh-context/snapshot', …)`；宿主端用
   `ctx.connection.fetch.register({ path, methods, requestBody, fetch })` 挂路由。

结论：**Electron 桌面端页面是 `file://` 起源，fetch 被 IPC 桥接管，只承载同源 `/api` 请求**。v0.1 设计的"自建 7317 端口 + 绝对地址"在桌面端永远到不了 Host——之前的"能拿到空快照"只是 Web 端/旧进程的假象。这也是当初"面板能否画出来"一直没人验证的那条洞。

### 修法（v0.2.3）

- Host 在 `apply()` 里通过 `ctx.connection.fetch.register` 注册 **11 条同源路由**：`/api/game-preview/{hello,state,roots,detect,run,stop,window/list,window/attach,window/stop,frame,log}`。
- 两条通道共用同一批处理函数（`snapshot` / `runPreview` / `attachWindow` / `rootsPayload`），HTTP 层只是外壳。
- 面板 `probe()` 先试同源 `api/game-preview/hello`，不通才退回 7317–7332 探测；顶栏状态行显示 `宿主 v0.2.3 · 同源 · F:\…`。
- 原生窗口画面在桌面端不能用 `<img src=流>`（同样跨端口），改为 **`/api/game-preview/frame` 轮询 → blob URL**，14 fps 左右；Web 端仍可走 MJPEG。
- `/api/debug` 增加 `sameOrigin` / `fetchRoutes` 两个字段，一眼看出桥有没有挂上。

### 验证

```
/api/debug → sameOrigin: true, fetchRoutes: 11
harness：11 条路由全部注册；hello/state/detect/roots 返回正确；未抓帧时 frame 返回 204
client-harness：窗口舞台在两种传输下都能渲染
```

### 教训

**别用"另起端口"绕开 Harness 的 API。** 自建 loopback 在 Web 端能跑，在桌面端（`file://` + IPC 桥）直接不通，而且失败是静默的——请求根本不发出去，Host 日志里什么都看不到。判断这类问题最快的办法：**看 Host 有没有收到请求**，而不是看页面显示了什么。

### 追加（v0.2.4）：相对路径不能提前解析

自检发现 `/api/game-preview/hello` 在连接路由表里是**命中**的（返回 403 只因为我传了假 Peer），`/game-preview/hello` 才是 404。真正的问题在客户端探测代码：它先用 `new URL('/api/game-preview/hello', location.href)` 把相对路径**解析成绝对 URL** 再 fetch。桌面端的 fetch 补丁是按 `"/api"` 字面前缀识别的，一旦变成 `file:///api/...` 就不再被接管 → 静默失败。

修法：探测与所有请求一律用字面量 `'/api/game-preview/...'` 调用 fetch；只有在 `location.origin` 是真实 http origin 时才追加一条绝对形式作为备选。

**教训**：在 `file://` 页面里，任何"先规范化 URL 再请求"的写法都可能绕过桥接层。要按官方客户端那样，直接把 `/api/...` 交给 fetch。

### 追加（v0.2.5）：同源通了，但 call() 把前缀拼重了

面板状态行第一次显示 `宿主 v0.2.3 · 同源`，说明同源路由**已经生效**；紧接着的红字 `HTTP 404` 是客户端自己的 bug：

- `call()` 里的路径仍是 loopback 形态 `/api/state`
- 同源 base 是 `/api/game-preview`
- 拼起来成了 `/api/game-preview/api/state` → 404

修法：`call()` 里先去掉路径里的 `/api` 前缀再拼 base；同时在 `client-harness.mjs` 加源码级回归检查（所有 `call('/api/...')` + 必须有 strip 逻辑），这类"两条通道拼接不一致"的问题不会再静默复发。

### 追加（v0.3.4）：探测器把面板挂死了

面板停在「正在连接宿主…」——不是被拒绝，是**请求一直挂着**：桌面端 preload 接管 `fetch` 后，对非同源 URL 既不 resolve 也不 reject；旧探测器是串行 await、没有超时，于是第一条就把整个 probe 卡死了，四条路径一条都没机会跑。

修法：
- 每个候选（同源 XHR / 16 个回环 XHR / 同源 fetch / 16 个回环 fetch）都有 **1.5s 硬超时**
- **4 路并发**扫描，谁先回应谁赢
- XHR 放在最前面（preload 换的是 fetch，不是 XMLHttpRequest）
- 拿到的 `transport` 记在 health 里，状态行会标 `(xhr)`

**教训：在会被中间层接管的运行时里，任何网络探测都必须自带超时，并且"失败"必须包含"没回应"。**
