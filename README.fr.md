# DSH Game Preview

**Un plugin de studio de jeux pour DeepSeek Harness.** Lancez votre jeu, capturez les fenêtres natives du moteur et jouez directement dans la barre latérale — sans changer de fenêtre ni faire Alt+Tab.

Réalisé par **邮差游戏工作室 / Postman Game Studio** pour les équipes qui créent des jeux *avec* DSH : l'agent modifie le code, le panneau montre le jeu, votre regard reste dans une seule fenêtre.

[English](README.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français**

![Capture native d'Unity dans la barre latérale](docs/images/unity-native-capture.jpg)

*L'éditeur Unity capturé en direct dans la barre latérale — 1920×1030 à 15 fps, recadré sur la vue Game, clavier et souris transmis.*

## Pourquoi

Chaque moteur a une boucle plus rapide que les autres ; le panneau la choisit tout seul :

| Moteur | Boucle la plus rapide | Ce que fait l'aperçu |
|---|---|---|
| Cocos Creator | Aperçu navigateur de l'éditeur (~1 s) | Se connecte à `localhost:7456` et garde le HMR |
| Godot | F5 → fenêtre native (~2 s) | `godot --path .`, capture la fenêtre |
| Unity | Play de l'éditeur (~3 s) | `Unity.exe -projectPath`, suit le passage splash → éditeur |
| Mini-jeu WeChat | Build dans les DevTools (~90 s) | Ouvre le projet dans les DevTools WeChat |
| Web / statique | serveur dev ou fichiers | Lance le script ou sert le dossier tel quel |
| Builds du moteur | `build/web-desktop/index.html` | Sert le paquet exporté, en vue PC ou mobile |

**Il ne demande jamais « quel moteur ? »** — l'URL manuelle n'arrive que si rien n'est reconnu.

## Fonctionnalités

| | |
|---|---|
| **Capture native** | `PrintWindow` avec pipeline capture/encodage à deux threads, 15–24 fps ; *net* (taille native) ou *fluide* (1100 px, ~24–30 fps) |
| **Jouer dans le panneau** | 🖱 transmet souris et clavier à la fenêtre capturée, avec correction DPI, F1–F12, flèches et modificateurs |
| **Recadrer sur la vue Game** | ✂ tracez un rectangle et ne gardez que cette zone ; mémorisé par titre de fenêtre |
| **PC / mobile / auto** | Viewports logiques réels 1280×720 et 390×844, mis à l'échelle |
| **Démarrage automatique** | Ouvrir le panneau restaure la dernière fenêtre ou configuration du projet |
| **Compteur de modifications** | Enregistrer ne recharge pas ; le panneau indique combien de changements attendent |
| **Outils pour l'agent** | `game_preview_run` / `status` / `stop` / `windows` |
| **Raccourcis** | `F` plein écran · `R` recharger · `Esc` quitter |

## Installation

Nécessite DeepSeek Harness `0.2.x` et Node.js 22+.

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-game-preview
```

ou demandez à l'agent dans DSH :

```
plugin_manager install_bundle(target: "C:\\\\path\\\\to\\\\dsh-game-preview")
```

Puis rechargez la page (Ctrl+R) : un ▶ apparaît près du titre de session et **游戏预览** dans le « + » de la barre latérale.

> La capture native, la transmission d'entrée et le lancement des moteurs sont **réservés à Windows 10/11**. Les aperçus web fonctionnent partout.

## Utilisation

1. Ouvrez la session dont l'espace de travail est votre jeu.
2. Cliquez sur ▶ (ou barre latérale → **+** → **游戏预览**).
3. Le panneau détecte le moteur et lance la boucle la plus rapide.
4. Modifiez le code — le compteur affiche `●3` ; appuyez sur ▶ ou laissez l'agent appeler `game_preview_run`.
5. Unity : appuyez une fois sur Play dans l'éditeur, recadrez la vue Game avec ✂, puis jouez avec 🖱.

## Configuration

Modifiez la ligne dans le `cordis.patch.yml` de votre profil :

```yaml
- id: dsh-game-preview
  config:
    port: 7317             # port de départ de l'API de contrôle (16 essais)
    captureFps: 20         # cadence cible
    captureWidth: 0        # réduire avant le JPEG ; 0 = taille native
    captureQuality: 70     # qualité JPEG
    captureWaitMs: 30000   # attente maximale de la fenêtre du moteur
    godotExe: ''           # chemin absolu si absent du PATH
    unityExe: ''           # <version>\\\\Editor\\\\Unity.exe
    cocosEditor: ''        # CocosCreator.exe
    wechatCli: ''          # cli.bat des DevTools WeChat
```

## Fonctionnement

La page du bureau s'exécute sur `dsh-app://app/`, où `fetch` et `XMLHttpRequest` vers le loopback sont interceptés. Le panneau communique donc via une iframe cachée (`GET /bridge`) servie par l'hôte, puis retombe sur les routes same-origin et l'API loopback `127.0.0.1:7317`.

## Limites connues

- Capture native, entrée et lancement de moteurs : Windows uniquement
- Le plein écran exclusif se capture en noir — passez en sans bordure
- Une fenêtre 4K en taille native tombe à ~10 fps ; utilisez « fluide »
- L'entrée couvre clavier et souris (pas de manette, IME non traduit)

## Développement

```bash
node scripts/harness.mjs          # Host : API de contrôle, détection, capture, entrée, routes
node scripts/client-harness.mjs   # Client : enregistrement et tous les états de l'UI
```

## Licence

MIT
