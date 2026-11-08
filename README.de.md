# DSH Game Preview

**Ein Game-Studio-Plugin für DeepSeek Harness.** Starte dein Spiel, fange native Engine-Fenster ein und spiele direkt in der Seitenleiste — kein Fensterwechsel, kein Alt-Tab.

Von **邮差游戏工作室 / Postman Game Studio** für Teams, die Spiele *mit* DSH bauen: Der Agent schreibt Code, das Panel zeigt das Spiel, dein Blick bleibt in einem Fenster.

[English](README.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Deutsch** · [Español](README.es.md) · [Français](README.fr.md)

![Nativer Unity-Capture in der Seitenleiste](docs/images/unity-native-capture.jpg)

*Der Unity-Editor live in der Seitenleiste — 1920×1030 bei 15 fps, auf die Game-Ansicht zugeschnitten, Maus und Tastatur weitergeleitet.*

## Warum

Jede Engine hat eine schnellste Schleife; das Panel wählt sie automatisch:

| Engine | Schnellste Schleife | Was die Vorschau tut |
|---|---|---|
| Cocos Creator | Browser-Vorschau im Editor (~1 s) | Verbindet `localhost:7456`, nutzt das HMR des Editors |
| Godot | F5 → natives Fenster (~2 s) | `godot --path .`, fängt das Fenster ein |
| Unity | Play-Modus im Editor (~3 s) | `Unity.exe -projectPath`, folgt dem Wechsel Splash → Editor |
| WeChat-Minispiel | Build in den DevTools (~90 s) | Öffnet das Projekt in den WeChat DevTools |
| Web / statisch | Dev-Server oder reine Dateien | Startet das Skript oder liefert den Ordner aus |
| Engine-Builds | `build/web-desktop/index.html` | Liefert das exportierte Bundle, PC- oder Handy-Viewport |

**Es fragt nie „welche Engine?“** — erst wenn nichts erkannt wird, kommt eine manuelle URL.

## Funktionen

| | |
|---|---|
| **Nativer Fenster-Capture** | `PrintWindow` mit zweithreadiger Capture/Encode-Pipeline, 15–24 fps; *scharf* (Originalgröße) oder *flüssig* (1100 px, ~24–30 fps) |
| **Im Panel spielen** | 🖱 leitet Maus und Tastatur an das Fenster weiter — DPI-korrekt, inkl. F1–F12, Pfeilen und Modifikatoren |
| **Auf die Game-Ansicht zuschneiden** | ✂ Rechteck über den Capture ziehen, nur diesen Bereich behalten; pro Fenstertitel gemerkt |
| **PC / Handy / Auto** | Echte logische Viewports 1280×720 und 390×844, passend skaliert |
| **Autostart** | Öffnet das Panel und stellt das letzte Fenster bzw. die letzte Konfiguration des Projekts wieder her |
| **Änderungszähler** | Speichern lädt nicht neu; das Panel zeigt, wie viele Änderungen warten |
| **Agent-Tools** | `game_preview_run` / `status` / `stop` / `windows` |
| **Tastenkürzel** | `F` Vollbild · `R` neu laden · `Esc` verlassen |

## Installation

Benötigt DeepSeek Harness `0.2.x` und Node.js 22+.

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

oder den Agenten in DSH fragen:

```
plugin_manager install_bundle(target: "C:\\\\path\\\\to\\\\dsh-game-preview")
```

Danach die Seite neu laden (Strg+R): ein ▶ erscheint neben dem Sitzungstitel, **游戏预览** in der Seitenleiste unter „+“.

> Nativer Capture, Eingabe-Weiterleitung und Engine-Start gibt es nur unter **Windows 10/11**. Web-Vorschauen laufen überall.

## Benutzung

1. Sitzung mit dem Spiel-Workspace öffnen.
2. ▶ anklicken (oder Seitenleiste → **+** → **游戏预览**).
3. Das Panel erkennt die Engine und startet die schnellste Schleife.
4. Code ändern — der Zähler zeigt `●3`; ▶ drücken oder den Agenten `game_preview_run` aufrufen lassen.
5. Unity: einmal Play im Editor, mit ✂ die Game-Ansicht zuschneiden, dann mit 🖱 direkt spielen.

## Konfiguration

Die Zeile in `cordis.patch.yml` des Profils anpassen:

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # Startport der Control-API (prüft 16 Ports)
    captureFps: 20         # Ziel-Bildrate
    captureWidth: 0        # vor JPEG verkleinern; 0 = Originalgröße
    captureQuality: 70     # JPEG-Qualität
    captureWaitMs: 30000   # Wartezeit auf das Engine-Fenster
    godotExe: ''           # absoluter Pfad, wenn nicht im PATH
    unityExe: ''           # <version>\\\\Editor\\\\Unity.exe
    cocosEditor: ''        # CocosCreator.exe
    wechatCli: ''          # WeChat DevTools cli.bat
```

## Funktionsweise

Die Desktop-Seite läuft unter `dsh-app://app/`, wo `fetch` und `XMLHttpRequest` an Loopback-Adressen abgefangen werden. Das Panel spricht daher über ein verstecktes iframe (`GET /bridge`) mit dem Host und fällt auf same-origin-Routen bzw. die Loopback-API `127.0.0.1:7317` zurück.

## Bekannte Grenzen

- Nativer Capture, Eingabe und Engine-Start nur unter Windows
- Exklusiver Vollbildmodus wird schwarz aufgenommen — auf randlos umstellen
- 4K-Fenster in Originalgröße fallen auf ~10 fps; „flüssig“ verwenden
- Eingabe nur Tastatur und Maus (keine Gamepads, keine IME-Übersetzung)

## Entwicklung

```bash
node scripts/harness.mjs          # Host: Control-API, Erkennung, Capture, Eingabe, Routen
node scripts/client-harness.mjs   # Client: Registrierung und alle UI-Zustände
```

## Lizenz

MIT
