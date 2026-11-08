# DSH 게임 프리뷰

**DeepSeek Harness용 게임 스튜디오 플러그인.** 게임을 실행하고, 네이티브 엔진 창을 캡처해서, 사이드바 안에서 그대로 플레이하세요. 창 전환도, Alt+Tab도 필요 없습니다.

**우체부 게임 스튜디오 / Postman Game Studio** 제작. DSH로 게임을 만드는 팀을 위해 — agent가 코드를 고치고, 패널이 게임을 보여주고, 시선은 한 창에 머뭅니다.

[English](README.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · **한국어** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md)

![사이드바로 캡처된 Unity 창](docs/images/unity-native-capture.jpg)

*Unity 에디터를 사이드바로 실시간 캡처 — 1920×1030 / 15 fps, Game 뷰로 크롭, 키보드·마우스 전달.*

## 왜 만들었나

엔진마다 가장 빠른 루프가 있고, 패널이 그것을 자동으로 고릅니다.

| 엔진 | 가장 빠른 루프 | 프리뷰가 하는 일 |
|---|---|---|
| Cocos Creator | 에디터 브라우저 프리뷰(~1초) | `localhost:7456` 연결, HMR 유지 |
| Godot | F5 → 네이티브 창(~2초) | `godot --path .`, 창 캡처 |
| Unity | 에디터 Play(~3초) | `Unity.exe -projectPath`, 스플래시→에디터 창 전환 추적 |
| 위챗 미니게임 | 개발자 도구 빌드(~90초) | WeChat DevTools로 프로젝트 열기 |
| Web / 정적 | dev 서버 또는 파일 | 스크립트 실행 또는 폴더 그대로 서빙 |
| 엔진 빌드 산출물 | `build/web-desktop/index.html` | 내보낸 번들을 PC / 모바일 뷰포트로 서빙 |

**"무슨 엔진 쓰세요?"라고 묻지 않습니다** — 판별이 안 될 때만 수동 URL로 넘어갑니다.

## 기능

| | |
|---|---|
| **네이티브 창 캡처** | `PrintWindow` + 캡처/인코딩 2스레드, 15–24 fps. 선명(원본) / 부드럽게(1100px, ~24–30 fps) |
| **패널에서 플레이** | 🖱 마우스·키보드를 대상 창으로 전달 (DPI 보정, F1–F12, 방향키, 수정 키) |
| **Game 뷰 크롭** | ✂ 화면에서 사각형을 골라 그 부분만 표시, 창 제목별로 기억 |
| **PC / 모바일 / 자동** | 1280×720, 390×844 논리 뷰포트를 실제 크기로 확보하고 비율 유지 축소 |
| **자동 시작** | 프로젝트별 마지막 창/설정을 기억해 열면 복원 후 실행 |
| **변경 카운터** | 저장은 새로고침하지 않고, 대기 중인 변경 수만 표시 |
| **Agent 도구** | `game_preview_run` / `status` / `stop` / `windows` |
| **단축키** | `F` 전체 화면 · `R` 새로고침 · `Esc` 해제 |

## 설치

DeepSeek Harness `0.2.x`, Node.js 22+ 필요.

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

또는 DSH의 agent에게:

```
plugin_manager install_bundle(target: "C:\\\\path\\\\to\\\\dsh-game-preview")
```

페이지를 새로고침(Ctrl+R)하면 세션 제목 옆에 ▶, 우측 사이드바 "+"에 **游戏预览**가 나타납니다.

> 네이티브 캡처·입력 전달·엔진 실행은 **Windows 10/11 전용**입니다. 웹 프리뷰는 모든 플랫폼에서 동작합니다.

## 사용법

1. 게임 워크스페이스의 세션 열기
2. ▶ 클릭(또는 우측 사이드바 → **+** → **游戏预览**)
3. 엔진을 자동 감지해 가장 빠른 루프 실행
4. 코드 수정 — `●3` 이 보이면 ▶ 또는 agent의 `game_preview_run`
5. Unity: 에디터에서 Play 한 번, ✂ 로 Game 뷰 크롭, 🖱 로 바로 플레이

## 설정

프로필의 `cordis.patch.yml`에서 해당 행을 수정합니다.

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # 제어 API 시작 포트
    captureFps: 20         # 목표 캡처 프레임
    captureWidth: 0        # 인코딩 전 축소(0 = 원본)
    captureQuality: 70     # JPEG 품질
    captureWaitMs: 30000   # 엔진 창 대기 상한
    godotExe: ''           # PATH에 없을 때 절대 경로
    unityExe: ''           # <version>\\\\Editor\\\\Unity.exe
    cocosEditor: ''        # CocosCreator.exe
    wechatCli: ''          # WeChat DevTools cli.bat
```

## 동작 원리

데스크톱 앱의 페이지는 `dsh-app://app/`에서 실행되며, 루프백으로 향하는 `fetch` / `XMLHttpRequest`는 가로채입니다. 그래서 패널은 Host가 제공하는 숨은 iframe(`GET /bridge`)으로 통신하고, 불가능할 때는 동일 출처 라우트와 루프백 API `127.0.0.1:7317`로 물러납니다.

## 알려진 제한

- 네이티브 캡처·입력 전달·엔진 실행은 Windows 전용
- 독점 전체 화면 창은 검게 캡처됩니다(테두리 없음 모드로 변경)
- 4K 창을 원본 크기로 캡처하면 약 10 fps. "부드럽게"를 사용하세요
- 입력은 키보드·마우스만(게임패드 미지원, IME 미처리)

## 개발

```bash
node scripts/harness.mjs          # Host: 제어 API, 감지, 캡처, 입력, 라우트
node scripts/client-harness.mjs   # Client: 등록과 각 UI 상태
```

## 라이선스

MIT
