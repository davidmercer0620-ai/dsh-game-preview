# 把游戏塞进 AI 编辑器的侧边栏：一次 15 fps 的工程实践

> 这篇写给想看"怎么做出来的"的人。所有数字都来自真实运行，不是估算。

## 0. 起点：一个断掉的回路

我们是一间两个人的游戏工作室，用 DeepSeek Harness（一个 AI 编码代理）写游戏。日常长这样：

```
agent 改代码 → 我切到引擎 → 跑一遍 → 切回来 → 描述"刚才那个按钮歪了"
```

断点很明显：**agent 写完就看不见结果**，我只能充当它的眼睛。

第一反应是"把游戏画面放进侧栏"。这个想法被一位资深开发者当头泼了冷水：

> "插件对我来说完全没用。游戏预览类似录屏，双屏开发用不上。AI 用 Unity 全部是用接口在后台跑脚本，编辑器几乎不会有任何动作，只有在最后的测试阶段会启动游戏跑。"

他是对的。**看编辑器直播**在 AI 工作流里没有价值。这件事后来变成了整个项目的转折点（见 §5）。

## 1. 第一个坑：fetch 打不通

DSH 桌面版的页面跑在 `dsh-app://app/`。要让侧栏去问本地插件服务（`127.0.0.1:7317`），最自然的是 `fetch`。

结果：**静默失败**。不是 CORS 报错，不是超时——请求根本发不出去，preload 把它拦了，连 `catch` 都不进。

实测只有两条路能通：

1. 一个隐藏的同源 iframe（`GET /bridge`）+ `postMessage`
2. `<img>` / `<iframe>` 这种不经过 fetch 的加载

所以传输层写成了三段探测：`bridge → XHR → fetch`，各带 1.5 秒死线，并发 4 个候选。后来还补了一个自愈：桥连续超时就销毁重建（宿主重启后旧 iframe 会变成死帧，表现为"面板静默停摆"，非常像 bug）。

**教训**：在嵌入式浏览器里，"请求失败"可能连异常都没有。必须给每次调用设死线，否则你会对着一个永远 pending 的 Promise 调一天。

## 2. 第二个坑：PrintWindow 到底能不能用

抓原生窗口有两条路：

| 方案 | 要求 | 实测 |
|---|---|---|
| `Windows.Graphics.Capture` (WGC) | Windows SDK 的 WinRT 元数据 | 这台机器没装，`Add-Type` 直接失败 |
| `PrintWindow(PW_RENDERFULLCONTENT)` | 无 | **1920×1030 @ 15.2 fps**，单帧 107 KB |

选了 PrintWindow。它要求目标窗口自己重绘到内存 DC，所以：

- 有些 GPU 独占全屏的窗口抓出来是黑的（我们检测到黑帧会标记 `black` 并提示）
- DPI 必须统一：进程要 `SetProcessDpiAwarenessContext(-4)`，否则高分屏上坐标和位图对不上

架构是"PowerShell 宿主 + C# 辅助类"：

```
Node ──spawn──> powershell.exe (window-capture.ps1)
                    └─ Add-Type 编译 C# 类，两个线程：抓帧 / 编码
       <──stdout── 行协议：FRAME <seq> <w> <h> <bytes> <base64 JPEG>
```

C# 5 的老坑：`?.`、`$"{}"`、`sizeof` 在 `Add-Type` 里都不能用，编译报错还挺难读。

## 3. 输入转发：坐标要说同一种语言

抓到的帧是**物理像素**，但用户在面板里点的是 **CSS 像素**。中间隔着缩放、DPI、设备框。

做法：面板只上报 0..1 的归一化坐标，宿主用 `GetWindowRect` 换算成屏幕坐标，再 `SetCursorPos` + `mouse_event`。这样面板怎么缩放都不影响。

键盘简单些：`keybd_event` + 虚拟键码表，但要注意**先 `SetForegroundWindow`**，否则按键进了别的窗口。

踩过的坑：一次误点把用户右侧栏关掉——因为坐标算错了一档。后来所有点击脚本都改成从帧宽高换算，不再手写像素。

## 4. 先别急着做"更多功能"：三次白屏

v0.5 的时候面板打不开了，纯白。查了三轮：

1. **包重命名**（`dsh-game-preview` → `@scope/dsh-game-preview`）留下了两条 client entry，同一个模块注册两次，宿主直接拒绝
2. **tab id 跟着改名**，会话里保存的旧 tab 找不到 body
3. **React hooks 顺序**：`useRef` 写在了两个 early return 之后，首屏骨架屏走不到它，第二屏数据到了才走——hooks 数量变了，`#310`，整个面板卸载

第 3 个最有意思：它是**只有真实数据到达时才炸**的那种 bug，本地测试永远绿。修法很土但有效——给面板包一层 error boundary，出问题把堆栈**画在 UI 上**，而不是白屏。后来还加了出错自动上报到宿主，我不用再让用户截图。

## 5. 真正的转折：不看直播，看结果

那位开发者的第二句话是关键：

> "比如我让它从零开始搭场景，开始的时候是空场景，然后一直埋头苦干，干完了，闪一下就变成这样了。"

他要的不是过程，是**结果的变化**。于是产品转向：

- **变化门控的记录**：每帧算 SHA1，和上一帧一样就丢掉；最少间隔 8 秒。十分钟的工作 → 十几张静帧（约 640 KB），空闲编辑器一帧不存
- **一键 GIF**：这些静帧直接合成 `timelapse.gif`，能贴进 review
- **项目看板**：单屏同时开几个游戏时，每个项目一张最新画面，点一下切换

## 6. 让 agent 有眼睛：探针注入

这是我觉得最值的一个设计。

插件本来就**代理着静态文件**（`/static/<token>/...`），所以完全可以在返回 HTML 时插一段脚本：

```js
// 服务端注入，页面自己上报
window.addEventListener('error', …)          // 未捕获异常 + 资源 404
window.addEventListener('unhandledrejection', …)
console.error = …                            // 保留原函数再转发
requestAnimationFrame(loop)                  // 每 2 秒报一次 FPS
navigator.sendBeacon('/api/probe', …)
```

于是 agent 在改完代码后可以问：**"页面报错了没有？跑多少帧？"**

真实数据：`炉石传说` web-mobile 构建 → `fps: 60 · errors: 0 · 404: 0`。

这条的价值不在"一切正常"，而在**不正常的时候**：以前 agent 只能说"我改完了"，现在它能收到

```
TypeError: xxx is not a function at assets/main/index.js:1:234
```

## 7. 把验证变成一条命令

把上面所有东西串起来，就是 `game_preview_check`：

```
页面报错 + 帧率  →  抓一张图  →  可选的回放脚本
      →  和上次自检做像素对比  →  包体积 + 引擎裁剪建议
      →  pass / warn / fail + 证据路径
```

真实输出：

```
结论: warn
fps: 60 · 错误: 0
原因: 引擎还有 14 个未使用模块可裁剪（预计省 0.5–1.5 MB）
```

那个 `warn` 是扫描了 7 个场景、25 个脚本后得出的：这个纯 `Graphics` 绘制的 2D 项目，Physics/Spine/DragonBones/TiledMap/Video/WebView/Skeletal/3D Mesh/Lighting/Terrain 一个都没用到，而引擎包有 3.96 MB。

## 8. 数字汇总

| 项目 | 数值 |
|---|---|
| Unity 编辑器抓帧 | 1920×1030 @ 15.2 fps，107 KB/帧 |
| Android APK（Gradle） | 1 分 20 秒，6.5 MB |
| TapTap 提交包 | 0.64 MB（4 MB 上限的 16%） |
| 引擎可裁剪模块 | 14 个（3.96 MB 的引擎包） |
| web 构建运行时 | 60 fps，0 错误 |
| 变化门控记录 | 45 秒 → 12 帧 / 640 KB |

## 9. 如果重来一次，我会先做这三件事

1. **先写错误边界**。白屏浪费的时间远超它省下的时间。
2. **先验证传输层**。`dsh-app://` 页面里 fetch 静默失败这件事，值得第一天就测出来。
3. **先找一个真实用户骂你**。那句"这插件完全没用"比我自己想一个月都有价值。

---

代码：<https://github.com/davidmercer0620-ai/dsh-game-preview>（MIT）
