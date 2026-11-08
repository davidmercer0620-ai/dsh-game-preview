# DSH 遊戲預覽

**給 DeepSeek Harness 的遊戲工作室外掛。** 跑起你的遊戲、擷取原生引擎視窗，直接在右側欄玩——不用切視窗、不用 Alt+Tab。

由 **郵差遊戲工作室 / Postman Game Studio** 開發，給用 DSH 做遊戲的團隊：agent 改程式碼，面板顯示遊戲，你的眼睛留在同一個視窗裡。

[English](README.md) · [简体中文](README.zh.md) · **繁體中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md)

![右側欄裡的 Unity 原生擷取](docs/images/unity-native-capture.jpg)

*Unity 編輯器即時擷取到右側欄——1920×1030、15 fps，裁到 Game 視圖，滑鼠鍵盤可轉發。*

## 為什麼做它

每個引擎都有最快的那條迴路，面板會自動挑：

| 引擎 | 最快迴路 | 預覽怎麼做 |
|---|---|---|
| Cocos Creator | 編輯器瀏覽器預覽（~1 秒） | 連 `localhost:7456`，保留編輯器的 HMR |
| Godot | F5 → 原生視窗（~2 秒） | `godot --path .`，擷取視窗 |
| Unity | 編輯器 Play（~3 秒） | `Unity.exe -projectPath`，擷取編輯器並跟隨「啟動畫面 → 編輯器」換窗 |
| 微信小遊戲 | 開發者工具建置（~90 秒） | 用微信開發者工具開啟專案 |
| Web / 靜態 | dev server 或純檔案 | 啟動腳本，或直接以目錄提供服務 |
| 引擎建置產物 | `build/web-desktop/index.html` | 直接服務匯出的包，PC / 手機視口 |

**它永遠不問「你用什麼引擎」**——偵測不到才退回手動 URL。

## 能力

| | |
|---|---|
| **原生視窗擷取** | `PrintWindow` + 擷取/編碼雙執行緒，15–24 fps；「清晰」（原尺寸）或「流暢」（1100px，~24–30 fps） |
| **在面板裡玩** | 🖱 把滑鼠鍵盤轉發到目標視窗，含 DPI 校正、F1–F12、方向鍵與修飾鍵 |
| **裁到 Game 視圖** | ✂ 在畫面上框選一塊長期只看它，依視窗標題記憶 |
| **PC / 手機 / 自適應** | 真正的 1280×720 與 390×844 邏輯視口，等比縮放 |
| **開啟即啟動** | 記住每個專案上次的視窗或設定，開啟面板自動恢復並執行 |
| **髒改動計數** | 儲存不重新載入，只顯示待執行數量 |
| **Agent 工具** | `game_preview_run` / `status` / `stop` / `windows` |
| **快速鍵** | `F` 滿版 · `R` 重新載入 · `Esc` 離開 |

## 安裝

需求：DeepSeek Harness `0.2.x`、Node.js 22+。

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

或請 DSH 裡的 agent 執行：

```
plugin_manager install_bundle(target: "C:\\\\path\\\\to\\\\dsh-game-preview")
```

安裝後重新整理頁面（Ctrl+R）：標題列出現 ▶，右側欄「+」裡出現 **遊戲預覽**。

> 原生擷取、輸入轉發與引擎啟動僅支援 **Windows 10/11**；網頁預覽跨平台可用。

## 用法

1. 開啟工作區指向遊戲專案的工作階段
2. 點 ▶（或右側欄 → **+** → **遊戲預覽**）
3. 面板自動偵測引擎並啟動最快迴路
4. 改程式碼——計數顯示 `●3`，按 ▶ 或讓 agent 呼叫 `game_preview_run`
5. Unity：在編輯器按一次 Play，用 ✂ 裁出 Game 視圖，再點 🖱 直接玩

## 設定

在 profile 的 `cordis.patch.yml` 裡修改對應列：

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # 控制 API 起始埠
    captureFps: 20         # 目標擷取率
    captureWidth: 0        # 編碼前縮放；0 = 原尺寸
    captureQuality: 70     # JPEG 品質
    captureWaitMs: 30000   # 等引擎視窗的上限
    godotExe: ''           # 不在 PATH 時填絕對路徑
    unityExe: ''           # <版本>\\Editor\\Unity.exe
    cocosEditor: ''        # CocosCreator.exe
    wechatCli: ''          # 微信開發者工具 cli.bat
```

## 原理

桌面端頁面執行在 `dsh-app://app/`，對回環位址的 `fetch` / `XMLHttpRequest` 會被攔截。面板因此透過 Host 提供的隱藏 iframe（`GET /bridge`）通訊，不可用時退回同源路由與回環 API `127.0.0.1:7317`。

## 已知限制

- 原生擷取、輸入轉發、引擎啟動僅限 Windows
- 獨佔全螢幕視窗擷取為黑畫面，請改無邊框
- 4K 視窗原尺寸約 10 fps，建議用「流暢」檔
- 輸入轉發支援鍵鼠（不含手把），輸入法未處理

## 開發

```bash
node scripts/harness.mjs          # Host：控制 API、偵測、擷取、輸入、路由
node scripts/client-harness.mjs   # Client：註冊與各 UI 狀態
```

## 授權

MIT
