# Android Runner

A small VS Code extension that auto-detects Android projects and gives you a **one-click build → install → launch** flow, directly from the editor.

When an Android project is open, a prominent **green `▶ Run Android`** item appears on the left of the VS Code status bar. Clicking it:

1. Runs `./gradlew assembleDebug` (configurable), streaming logs to an `Android Runner` output channel.
2. Asks you to pick a connected adb device/emulator.
3. Installs the freshly built APK with `adb install -r -t`.
4. Launches the app's main launcher activity via `adb shell am start`.

---

## Why a status bar button (and not next to the title-bar search)?

The original ask was for a green play button "right next to the Command Center search bar at the top of VS Code". VS Code's public extension API has **no contribution point** for that area — extensions cannot inject UI into the title bar / Command Center. The closest *idiomatic* and *always-visible* spot is the **status bar (left)**, which is also where built-in extensions like the npm Scripts and Run/Debug extensions surface similar Run actions. We made the button visually distinct using a custom themable green background (`androidRunner.runButtonBackground`).

If a future API exposes the title bar area, swapping the placement requires only changing one contribution point — the rest of the build/install/launch pipeline is unaffected.

---

## Features

- **Automatic detection** of Android projects via gradle markers (`settings.gradle[.kts]`, `gradlew`) and/or any `AndroidManifest.xml`. The button is hidden in non-Android workspaces.
- **Live build logs** in a dedicated `Android Runner` output channel.
- **Cancellable build progress** notification (Cmd/Ctrl+click the cancel button to kill gradle).
- **Always-prompt device picker** with a Refresh action (helpful when you start an emulator after clicking Run).
- **Always-prompt user-profile picker** (Owner / Work profile / other secondary users) — the APK is installed and launched as the chosen Android user via `adb install --user` and `am start --user`.
- **Launcher activity auto-discovery** by parsing the merged manifest (falls back to source manifest, then to gradle `namespace`, then to `adb shell monkey`).
- **Multi-module support** — prefers `app/build/outputs/apk/debug/*.apk`, prompts on ambiguity.
- **Keybinding**: `Shift+F10` (Android-Studio-style) runs the flow when an Android project is detected.

---

## Requirements

- **JDK 17+** on `PATH` (required by current Android Gradle Plugin versions).
- **Android SDK** with platform-tools (`adb`) installed.
  - `adb` is auto-discovered via the `androidRunner.adbPath` setting → `ANDROID_HOME` → `ANDROID_SDK_ROOT` → `PATH`.
- **Gradle wrapper** (`gradlew` / `gradlew.bat`) checked into the project root. Generate one with `gradle wrapper` if missing.
- A **connected device** with USB debugging enabled, or a running **emulator**.

---

## Usage

1. Open an Android project folder in VS Code (the workspace root should contain `settings.gradle[.kts]` or `gradlew`, or an `AndroidManifest.xml` somewhere inside).
2. Wait a moment — the green `▶ Run Android` button will appear on the left of the status bar.
3. Click it (or press `Shift+F10`).
4. Watch `gradlew assembleDebug` run in the **Output → Android Runner** panel.
5. When the build succeeds, pick a device from the QuickPick (use **Refresh** if you just plugged one in).
6. Pick the Android **user profile** to install into (e.g. *Owner*, *Work profile*, or any secondary user reported by `pm list users`).
7. The APK installs, the app launches, and you're done.

If anything fails, the error notification offers an **Open Logs** action that jumps straight to the output channel.

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `androidRunner.gradleTask` | `assembleDebug` | Gradle task to invoke. |
| `androidRunner.gradleArgs` | `[]` | Extra arguments appended to gradle (e.g. `["--info", "-x", "lint"]`). |
| `androidRunner.adbPath` | `""` | Absolute path to `adb`. Leave empty to auto-detect. |

Themable colors (override in your `workbench.colorCustomizations`):

| Color id | Default |
|---|---|
| `androidRunner.runButtonBackground` | `#16a34a` |
| `androidRunner.runButtonForeground` | `#ffffff` |

---

## Design

### Module map

| File | Responsibility |
|---|---|
| `src/extension.ts` | `activate`/`deactivate`, status bar item lifecycle, the `androidRunner.run` command, and the high-level orchestration (build → pick device → install → launch). |
| `src/detectAndroidProject.ts` | Heuristic detection (`isAndroidProject`) plus a multi-folder picker (`resolveAndroidFolder`). |
| `src/buildAndroid.ts` | The `Android Runner` output channel singleton, gradle wrapper spawn, line-buffered streaming, cancellation, and APK discovery. |
| `src/adb.ts` | `findAdb`, `listDevices` (parses `adb devices -l`), `pickDevice` (always-prompt QuickPick), `install`, `launch`, `launchViaMonkey`. |
| `src/manifestParser.ts` | Regex-based extraction of `package` / `namespace` and the `MAIN`+`LAUNCHER` activity. Prefers the merged manifest. |

### Detection strategy

We avoid loading or executing project files to keep activation cheap. Detection considers a folder Android if **any** of:

- `settings.gradle` or `settings.gradle.kts` exists AND (`build.gradle[.kts]` or `gradlew` exists).
- Any `AndroidManifest.xml` is reachable inside the workspace (via `vscode.workspace.findFiles`).
- `gradle.properties` mentions `android.useAndroidX`.

Detection is recomputed when workspace folders change and when any of the marker files appear/disappear (via `FileSystemWatcher`). The state is also written to the context key `androidRunner.isAndroidProject` so the `Shift+F10` keybinding only triggers in Android workspaces.

### Build / install / launch sequence

```
click ▶ Run Android
   ├─ refresh detection (sanity check)
   ├─ runBuild(folder)                  ── spawns ./gradlew assembleDebug, streams to Output
   │     └─ locateApk()                 ── prefers app/build/outputs/apk/debug/*.apk
   ├─ pickDevice()                       ── adb devices -l → QuickPick (always prompts)
   ├─ pickUser(serial)                   ── adb shell pm list users → QuickPick (always prompts)
   ├─ install(serial, apkPath, userId)   ── adb -s <serial> install -r -t --user <id> <apk>
   └─ getLauncherInfo(folder)
         ├─ merged manifest (build/intermediates/merged_manifests/**)
         ├─ source manifest (src/main/AndroidManifest.xml, app/ preferred)
         └─ gradle namespace fallback
       → launch(serial, pkg, activity, userId)    ── adb shell am start --user <id> -n <pkg>/<activity>
         OR  launchViaMonkey(serial, pkg, userId)   ── adb shell monkey --user <id> ... LAUNCHER 1
```

Each subprocess invocation logs its argv to the `Android Runner` output channel for transparency.

### Why a regex manifest parser?

Adding `xml2js` or `fast-xml-parser` would inflate the extension and force a bundler. The manifest grammar we care about (a `<manifest package="…">` attribute and `<activity>` blocks with intent filters) is regular enough that a focused regex keeps the extension dependency-free and start-up fast.

---

## Development

```bash
git clone <this-repo>
cd AndroidRunner
npm install
npm run compile   # one-shot
npm run watch     # incremental
```

Open the folder in VS Code and press <kbd>F5</kbd> to launch an Extension Development Host. Open any Android project inside it and the green button should appear on the status bar.

### Recommended workflow

1. `npm run watch` in a terminal.
2. F5 to launch the dev host.
3. Edit `src/*.ts`; reload the dev host (`Cmd/Ctrl+R` inside it) to pick up changes.

---

## Known limitations

- **No marketplace metadata** — the extension is local-only (publisher `local`). To distribute, set a real `publisher`, add an icon, and run `vsce package`.
- **Debug variant only by default** — switch via `androidRunner.gradleTask`. Release/signed flows aren't wired (no keystore prompt).
- **No instrumented tests / `connectedAndroidTest`**.
- **No emulator lifecycle management** — devices must already be visible to `adb devices`.
- **No on-device LogCat viewer** — out of scope; pair with another extension if you need one.
- **Regex manifest parser** is not a full XML implementation; pathological manifests (e.g. activities with nested HTML-like CDATA tricks) may not parse. The merged manifest produced by AGP is always well-formed in practice.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Status bar button doesn't appear | Verify the workspace has `settings.gradle*` + `gradlew`, or any `AndroidManifest.xml`. Run the command **Developer: Reload Window**. |
| `Gradle wrapper not found` | Run `gradle wrapper` in the project root, or commit `gradlew` / `gradlew.bat` from upstream. |
| `adb not found` | Set `androidRunner.adbPath` to the full path of `adb`, or export `ANDROID_HOME`. |
| "No connected devices" | Plug in a device (USB debugging enabled) or start an emulator, then click **Refresh** in the picker. |
| Build fails on first run only | Often a Gradle daemon priming issue — click Run again. Check the **Android Runner** output channel for the actual stack trace. |

---

## License

This is a local utility extension. No license is set — adapt as you see fit.
