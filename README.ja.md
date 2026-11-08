# DSH ゲームプレビュー

**DeepSeek Harness 向けのゲームスタジオ用プラグイン。** ゲームを起動し、ネイティブエンジンのウィンドウを取り込み、サイドバーの中でそのまま遊べます。ウィンドウ切り替えも Alt+Tab も不要。

**郵差ゲームスタジオ / Postman Game Studio** 製。DSH でゲームを作るチームのために — agent がコードを書き、パネルがゲームを映し、視線はひとつのウィンドウに留まります。

[English](README.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · **日本語** · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md)

![サイドバーに取り込んだ Unity ウィンドウ](docs/images/unity-native-capture.jpg)

*Unity エディタをサイドバーへライブ取り込み — 1920×1030 / 15 fps、Game ビューにクロップ、キーボードとマウスを転送。*

## なぜ作ったか

どのエンジンにも一番速いループがあり、パネルはそれを自動で選びます。

| エンジン | 最速のループ | プレビューの動き |
|---|---|---|
| Cocos Creator | エディタのブラウザプレビュー（約1秒） | `localhost:7456` に接続し、HMR をそのまま利用 |
| Godot | F5 → ネイティブウィンドウ（約2秒） | `godot --path .` で起動しウィンドウを取得 |
| Unity | エディタの Play（約3秒） | `Unity.exe -projectPath`、スプラッシュ→エディタのウィンドウ切替を追跡 |
| WeChat ミニゲーム | 開発ツールでビルド（約90秒） | WeChat DevTools でプロジェクトを開く |
| Web / 静的 | dev サーバーまたは素のファイル | スクリプト起動、またはフォルダをそのまま配信 |
| エンジンのビルド成果物 | `build/web-desktop/index.html` | 書き出したバンドルを PC / スマホ表示で配信 |

**「どのエンジン？」とは決して聞きません** — 判定できないときだけ手動 URL に切り替わります。

## 機能

| | |
|---|---|
| **ネイティブ取り込み** | `PrintWindow` + 取得/エンコードの2スレッド構成、15–24 fps。シャープ（原寸）とスムーズ（1100px、約24–30 fps） |
| **パネル内でプレイ** | 🖱 マウスとキーボードを対象ウィンドウへ転送（DPI 補正、F1–F12、矢印キー、修飾キー） |
| **Game ビューへクロップ** | ✂ 画面上で矩形を選び、その範囲だけを表示。ウィンドウ名ごとに記憶 |
| **PC / スマホ / 自動** | 1280×720 と 390×844 の論理ビューポートを実寸で確保し、等比縮小 |
| **自動起動** | プロジェクトごとに前回のウィンドウ／設定を覚え、開いたら復元して起動 |
| **変更カウンタ** | 保存では再読み込みせず、待機中の変更数を表示 |
| **Agent ツール** | `game_preview_run` / `status` / `stop` / `windows` |
| **ショートカット** | `F` 全画面 · `R` 再読み込み · `Esc` 解除 |

## インストール

DeepSeek Harness `0.2.x`、Node.js 22+ が必要です。

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

または DSH の agent に:

```
plugin_manager install_bundle(target: "C:\\\\path\\\\to\\\\dsh-game-preview")
```

ページを再読み込み（Ctrl+R）すると、セッション見出しに ▶、右サイドバーの「+」に **游戏预览** が現れます。

> ネイティブ取り込み・入力転送・エンジン起動は **Windows 10/11 のみ**。Web プレビューは全プラットフォームで動作します。

## 使い方

1. ゲームのワークスペースでセッションを開く
2. ▶ をクリック（または右サイドバー → **+** → **游戏预览**）
3. エンジンを自動判定し、最速のループを起動
4. コードを編集 — `●3` と表示されたら ▶ か agent の `game_preview_run`
5. Unity: エディタで一度 Play、✂ で Game ビューを切り出し、🖱 でそのまま操作

## 設定

プロファイルの `cordis.patch.yml` の該当行を編集します。

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # 制御 API の開始ポート
    captureFps: 20         # 目標フレームレート
    captureWidth: 0        # エンコード前の縮小（0 = 原寸）
    captureQuality: 70     # JPEG 品質
    captureWaitMs: 30000   # エンジンウィンドウ待ちの上限
    godotExe: ''           # PATH に無い場合の絶対パス
    unityExe: ''           # <version>\\\\Editor\\\\Unity.exe
    cocosEditor: ''        # CocosCreator.exe
    wechatCli: ''          # WeChat DevTools の cli.bat
```

## 仕組み

デスクトップ版のページは `dsh-app://app/` で動作し、ループバック宛の `fetch` / `XMLHttpRequest` はインターセプトされます。そのためパネルは Host が配信する隠し iframe（`GET /bridge`）経由で通信し、利用できない場合は同一オリジンのルートやループバック API `127.0.0.1:7317` にフォールバックします。

## 既知の制限

- ネイティブ取り込み・入力転送・エンジン起動は Windows のみ
- 排他フルスクリーンのウィンドウは真っ黒になります（ボーダーレスに変更してください）
- 4K ウィンドウを原寸で取ると約10 fps。「スムーズ」を使ってください
- 入力はキーボードとマウスのみ（ゲームパッド非対応、IME 未対応）

## 開発

```bash
node scripts/harness.mjs          # Host: 制御 API、判定、取り込み、入力、ルート
node scripts/client-harness.mjs   # Client: 登録と各 UI 状態
```

## ライセンス

MIT
