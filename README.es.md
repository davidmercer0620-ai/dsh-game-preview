# DSH Game Preview

**Un plugin de estudio de juegos para DeepSeek Harness.** Ejecuta tu juego, captura ventanas nativas del motor y juégalo dentro de la barra lateral: sin cambiar de ventana y sin Alt+Tab.

Creado por **邮差游戏工作室 / Postman Game Studio** para equipos que hacen juegos *con* DSH: el agente edita el código, el panel muestra el juego y tu vista se queda en una sola ventana.

[English](README.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · **Español** · [Français](README.fr.md)

![Captura nativa de Unity en la barra lateral](docs/images/unity-native-capture.jpg)

*El editor de Unity capturado en vivo en la barra lateral: 1920×1030 a 15 fps, recortado a la vista Game, con teclado y ratón reenviados.*

## Por qué existe

Cada motor tiene un bucle más rápido que los demás; el panel lo elige solo:

| Motor | Bucle más rápido | Qué hace la vista previa |
|---|---|---|
| Cocos Creator | Vista previa del navegador (~1 s) | Conecta a `localhost:7456` y usa el HMR del editor |
| Godot | F5 → ventana nativa (~2 s) | `godot --path .` y captura la ventana |
| Unity | Play del editor (~3 s) | `Unity.exe -projectPath`, sigue el cambio splash → editor |
| Mini juego WeChat | Build en DevTools (~90 s) | Abre el proyecto en WeChat DevTools |
| Web / estático | servidor dev o archivos | Arranca el script o sirve la carpeta tal cual |
| Builds del motor | `build/web-desktop/index.html` | Sirve el paquete exportado, con vista PC o móvil |

**Nunca pregunta «¿qué motor usas?»** — solo cae a URL manual cuando no reconoce nada.

## Funciones

| | |
|---|---|
| **Captura nativa** | `PrintWindow` con canalización de dos hilos (captura/codificación), 15–24 fps; *nítido* (tamaño original) o *fluido* (1100 px, ~24–30 fps) |
| **Jugar en el panel** | 🖱 reenvía ratón y teclado a la ventana capturada, con corrección de DPI, F1–F12, flechas y modificadores |
| **Recortar a la vista Game** | ✂ arrastra un rectángulo y conserva solo esa zona; se recuerda por título de ventana |
| **PC / móvil / auto** | Viewports lógicos reales de 1280×720 y 390×844, escalados para encajar |
| **Inicio automático** | Al abrir el panel restaura la última ventana o configuración del proyecto |
| **Contador de cambios** | Guardar no recarga; el panel indica cuántos cambios esperan |
| **Herramientas para el agente** | `game_preview_run` / `status` / `stop` / `windows` |
| **Atajos** | `F` pantalla completa · `R` recargar · `Esc` salir |

## Instalación

Requiere DeepSeek Harness `0.2.x` y Node.js 22+.

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

o pídelo al agente dentro de DSH:

```
plugin_manager install_bundle(target: "C:\\\\path\\\\to\\\\dsh-game-preview")
```

Después recarga la página (Ctrl+R): aparece un ▶ junto al título de la sesión y **游戏预览** en el «+» de la barra lateral.

> La captura nativa, el reenvío de entrada y el arranque de motores son **solo para Windows 10/11**. Las vistas web funcionan en cualquier sistema.

## Uso

1. Abre la sesión cuyo espacio de trabajo sea tu juego.
2. Pulsa ▶ (o barra lateral → **+** → **游戏预览**).
3. El panel detecta el motor y arranca el bucle más rápido.
4. Edita código: el contador muestra `●3`; pulsa ▶ o deja que el agente llame a `game_preview_run`.
5. Unity: pulsa Play una vez en el editor, recorta la vista Game con ✂ y juega con 🖱.

## Configuración

Edita la fila en el `cordis.patch.yml` de tu perfil:

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # puerto inicial de la API de control (prueba 16)
    captureFps: 20         # tasa objetivo de captura
    captureWidth: 0        # reducir antes del JPEG; 0 = tamaño original
    captureQuality: 70     # calidad JPEG
    captureWaitMs: 30000   # espera máxima por la ventana del motor
    godotExe: ''           # ruta absoluta si no está en PATH
    unityExe: ''           # <version>\\\\Editor\\\\Unity.exe
    cocosEditor: ''        # CocosCreator.exe
    wechatCli: ''          # cli.bat de WeChat DevTools
```

## Cómo funciona

La página de escritorio se ejecuta en `dsh-app://app/`, donde `fetch` y `XMLHttpRequest` hacia loopback se interceptan. Por eso el panel habla con el host mediante un iframe oculto (`GET /bridge`) y, si falla, recurre a rutas del mismo origen y a la API loopback `127.0.0.1:7317`.

## Límites conocidos

- Captura nativa, entrada y arranque de motores solo en Windows
- Las ventanas en pantalla completa exclusiva se capturan en negro; usa sin bordes
- Una ventana 4K a tamaño original baja a ~10 fps; usa «fluido»
- La entrada cubre teclado y ratón (sin mandos); el IME no se traduce

## Desarrollo

```bash
node scripts/harness.mjs          # Host: API de control, detección, captura, entrada, rutas
node scripts/client-harness.mjs   # Client: registro y todos los estados de la UI
```

## Licencia

MIT
