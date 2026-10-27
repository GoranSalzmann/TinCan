# 13. Desktop App (Electron)

Cross-platform desktop (Windows, macOS, Linux) is the top client priority. This
doc covers the Electron shell around the shared renderer (12): process model,
security hardening, native integrations, packaging, updates, and per-OS
specifics. Version-specific Electron API facts are marked **(verify)** for the
pinned Electron version.

## 1. Process model

```
 Main process (Node)                       Renderer (Chromium, sandboxed)
 ─ app lifecycle, single-instance lock     ─ shared React app (apps/web build)
 ─ windows, tray, menus, notifications     ─ talks to server via fetch/WebSocket
 ─ updater                                 ─ LiveKit/WebRTC, audio worklets
 ─ safeStorage / secrets                   ─ uses window.tincan (preload bridge)
 ─ global shortcuts (toggle mute/deafen/leave)
 ─ screen source enumeration/selection         ▲
 ─ deep link handling                          │ typed IPC (contextBridge)
                                               ▼
                                    Preload script (isolated world)
```
- **One main window** plus optional **pop-out stream windows** (R-045), and a small **screen-picker** window or in-renderer dialog.
- Heavy work stays in the renderer (media). The main process stays thin and does no network I/O to the chat server except updates.
- Optional **utility process** later for a native denoiser (09 §3.1).

## 2. Content loading strategy

**Decision (proposed): bundle the renderer inside the app** and load it from a
custom privileged scheme (e.g. `app://tincan/`), then connect to the user's
chosen server URL from there. Alternative considered: load the web client from
the server URL.

| | Bundled renderer (chosen) | Load from server |
|---|---|---|
| Multiple instances | Easy (one client, many servers) | Awkward |
| Offline start / fast start | Yes | No |
| Version skew with server | Possible; handled by `apiVersion` negotiation (07 §6) | None |
| Security surface | Fixed, signed code; no remote code execution via the server | Server (or MITM) controls code run with native bridge access |
| Update cadence | Via app updater | Automatic |
The security row decides it: a hostile or compromised server must never be able
to ship JavaScript that can reach native bridges.

Consequence: cross-origin requests from `app://` to the server require CORS
allowances for that origin (07 §7), and the gateway accepts it in `Origin`
checks.

## 3. Security hardening (non-negotiable defaults)

| Setting / practice | Value |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` (all renderers incl. workers) | `false` |
| `sandbox` | `true` |
| `webSecurity` | `true` (never disabled) |
| `allowRunningInsecureContent` | `false` |
| `enableRemoteModule` / remote | never used |
| Preload exposes | A minimal, typed `window.tincan` API via `contextBridge`; never raw `ipcRenderer` |
| IPC | Channels allow-listed; every handler validates sender frame/origin (`event.senderFrame.url`) and validates arguments with zod |
| Navigation | `will-navigate` and `setWindowOpenHandler` deny everything except the app origin; external links go to `shell.openExternal` after URL scheme allow-list (`https:`, `http:`, `mailto:`), never `file:`/custom schemes |
| Permissions | `session.setPermissionRequestHandler` / `setPermissionCheckHandler`: allow only `media` (mic/camera), `display-capture`, `notifications`, `clipboard-sanitized-write` for the app origin; deny everything else |
| CSP | Strict CSP via meta/headers for the app scheme (15); `connect-src` limited to the configured instance origin(s) and LiveKit URL |
| Webviews | Disabled; no `<webview>`, no embedded third-party content |
| DevTools | Disabled in production builds unless a developer flag is set |
| Fuses | Electron Fuses set at build time: disable `RunAsNode`, `NODE_OPTIONS`, `--inspect` CLI, enable ASAR integrity validation, cookie encryption, `onlyLoadAppFromAsar` (verify available fuses) |
| Auto-update | Signed updates only; HTTPS; verify signatures (see §8) |
| Protocol handler | Custom scheme `app://` registered as secure/standard; `tincan://` for deep links, args parsed and validated |
| Remote code | No `eval`, no remote scripts, no loading code from instance servers |
| Dependencies | Minimal native modules; lockfile; audit in CI |

A short "Electron security checklist" (aligned with the official guidance) is
part of the PR template for `apps/desktop`.

## 4. Native feature design

### 4.1 Screenshare with source picker
- Renderer calls `navigator.mediaDevices.getDisplayMedia` as usual; the main process installs `session.setDisplayMediaRequestHandler` to answer it with the user's choice (verify API for the pinned version).
- Flow: renderer asks the bridge `getScreenSources()` → main uses `desktopCapturer.getSources({types:['screen','window'], thumbnailSize})` → renderer displays a picker (thumbnails, window titles, "share audio" toggle, preset selector) → renderer calls `selectScreenSource(id, {audio})` → main resolves the pending display-media request with that source → LiveKit publishes the track.
- Thumbnails refreshed ~1 Hz while the picker is open; closed picker releases capturers.
- **Audio capture:**
  - Windows: system loopback audio supported (Electron `audio: 'loopback'` in the display-media handler; verify), per-app capture where Chromium supports it.
  - Linux: PulseAudio/PipeWire loopback via Chromium's system-audio capture; capability varies; test matrix required.
  - macOS: system audio capture depends on OS version (macOS 13+ improvements via ScreenCaptureKit in newer Chromium; verify) and permission prompts; otherwise window capture without audio (K-06).
- **Wayland:** capture goes through the XDG desktop portal + PipeWire (Chromium feature flags such as `WebRTCPipeWireCapturer`, verify); the portal's own picker may replace our custom picker, so the UI must handle "OS picker chosen" gracefully (K-05). Launch flags like `--ozone-platform-hint=auto` set by default on Linux.
- Safety: show a persistent "You are sharing <source>" bar and a tray indicator; exclude Tin Can's own window from picker by default (avoids infinite mirror), with an opt-in.
- Capture-excluded content: provide a "protect my notifications" tip (Windows/macOS notification overlays appear in capture); optional "pause notifications while sharing" toggle (default on).

### 4.2 Push-to-talk and global shortcuts
**Decision (18 §F): no native global input hook in v1.** A hook that sees raw key-up/key-down events system-wide brings antivirus false positives, macOS Input Monitoring friction, a larger security surface, and still cannot work on Wayland. It is deferred to v1.1 as an optional feature (§4.2.3).

#### 4.2.1 What v1 provides
- **In-window push-to-talk (hold to talk):** key/mouse-button down and up events while a Tin Can window has focus (web and desktop). Release delay and cue sounds per 09 §10.
- **Global one-shot shortcuts** via Electron `globalShortcut` (key press only, no key release needed): **toggle mute**, **toggle deafen**, **leave voice**. These work while another app (a game, a browser) has focus, need no extra OS permission on Windows or macOS (verify on the pinned version), and work on X11.
- **Wayland:** `globalShortcut` is unreliable or unavailable for ordinary apps (newer Electron may use the XDG GlobalShortcuts portal; verify). Fallback for all Linux sessions: `tincan --toggle-mute` / `--toggle-deafen` / `--leave` commands that talk to the running instance over single-instance IPC, which users bind to a desktop-environment shortcut or a mouse button through their DE or a tool such as `input-remapper`.
- **Hands-free alternative for gaming:** voice-activity mode with the neural denoiser and optional gate (09) is the intended answer for users who cannot hold a key while another app has focus.

#### 4.2.2 Trade-off, stated plainly
Users who want classic "hold a key to talk while a full-screen game has focus" will not get it in v1. They can use voice activity plus a global toggle-mute shortcut. This is a deliberate trade for a smaller security and permissions surface.

#### 4.2.3 v1.1 option: native hold-to-talk
If demand justifies it: an opt-in native hook module (e.g. `uiohook-napi` or a custom module) providing global key down/up, active only while a PTT binding is configured and the user is in a call; macOS Input Monitoring onboarding; code-signing and AV-allow-listing work; no logging of keystrokes. Feasibility to be assessed alongside spike D3.

#### 4.2.4 Binding UI
Record any key combo or mouse button; conflict detection; separate bindings for in-window PTT and global shortcuts; per-profile.

### 4.3 Tray, menus, badges, notifications
- Tray icon states: idle, unread, in-call, muted/deafened; menu: Open, Mute/Unmute, Deafen, Leave voice, Quit.
- Close button behaviour (setting): minimise to tray (default on Windows/Linux when in a call) or quit; macOS follows platform convention (window close keeps app running).
- Badge: unread/mention count on dock/taskbar where supported (macOS `app.dock.setBadge`, Windows overlay icon, Linux Unity launcher API/StatusNotifier, best effort).
- Notifications: native via Electron `Notification`; click focuses the app and navigates to the message; grouped per channel; honours DND; suppressed while sharing the screen (setting).
- Application menu (macOS) with standard Edit/Window/Help roles; hidden menu bar elsewhere with accelerators still working.

### 4.4 Auto-start, background behaviour
- Optional "launch at login" (`app.setLoginItemSettings`), start minimised to tray.
- `webPreferences.backgroundThrottling = false` for the main window so audio worklets/timers aren't throttled when hidden; use `powerSaveBlocker` (`prevent-app-suspension`) while in a call so the OS doesn't sleep the machine/network.
- Idle detection through `powerMonitor` (system idle time) → presence "idle" after N minutes.

### 4.5 Deep links & single instance
- `tincan://invite/<host>/<code>` opens the app on the join screen; `tincan://channel/<host>/<channelId>` optional.
- `app.requestSingleInstanceLock()`; second launches forward their args (deep link, `--toggle-mute`) to the running instance.
- The web invite page offers "Open in Tin Can" (custom-scheme link) and "Continue in browser".

### 4.6 Pop-out windows
Pop-out stream viewer (R-045): a second BrowserWindow with the same hardened preload that renders the stream tile. Because a LiveKit `Room` lives in the main renderer, either (a) the pop-out receives the MediaStream through a shared renderer process (same-origin windows can share via `window.open` + `MediaStream` transfer is not directly supported across processes) or (b) the pop-out joins as a second *viewer-only* connection (extra identity, extra downstream bandwidth, more complexity) or (c) use the **Document Picture-in-Picture API / video PiP** for a floating always-on-top window within the same renderer (verify support in the pinned Chromium). Recommendation: (c) first for simple always-on-top PiP; evaluate (a) with `window.open` same-process child windows (Chromium can keep same-site child windows in one process; verify) for a full pop-out. Spike item T14.

### 4.7 Clipboard, drag & drop, file dialogs
Paste images from the clipboard into the composer; drag files from the OS; save-as dialogs via the main process for attachment downloads; `Open containing folder`.

## 5. Platform specifics

| Topic | Windows | macOS | Linux |
|---|---|---|---|
| Installer | NSIS (per-user, no admin) and optionally MSI for enterprise | DMG (universal or separate arm64/x64), drag to Applications | AppImage, `.deb`, `.rpm`, Flatpak (consider), Snap optional |
| Signing | Code-signing certificate (EV/OV or Azure Trusted Signing/SignPath for OSS; K-14) | Developer ID + **notarisation** + hardened runtime + entitlements | GPG-signed repo/packages optional; Flatpak via Flathub |
| Permissions | OS camera/mic privacy settings | Info.plist usage strings (`NSMicrophoneUsageDescription`, `NSCameraUsageDescription`), screen-recording permission | Portals (Flatpak), PipeWire |
| Entitlements (macOS hardened runtime) | n/a | `com.apple.security.device.audio-input`, `...camera`, JIT/unsigned memory if required by V8/WASM per Electron guidance (verify) | n/a |
| Audio devices | WASAPI via Chromium | CoreAudio | PulseAudio/PipeWire |
| Autostart | Registry run key via Electron | Login items | `.desktop` autostart entry |
| Update mechanism | electron-updater (NSIS) | electron-updater (needs signed + zip) | AppImage update works; deb/rpm rely on package repo or manual; Flatpak via store |
| HiDPI/Theme | Follows system | Follows system, vibrancy optional | Follows GTK/Qt best-effort, dark mode detection via `nativeTheme` |

## 6. Multiple instances (servers)

A user may belong to several Tin Can instances (friends A and friends B). The
desktop app keeps a **saved instances list** (name, URL, icon, token reference in
the OS keychain). v1 behaviour: one active instance connection at a time with a
quick switcher (voice disconnects on switch, with a prompt); simultaneous
connections can come later. First launch: "Enter your server address or open an
invite link". The bundled renderer (§2) makes this natural. The server list is
a bridge-managed store (`PlatformBridge.settingsStore`).

## 7. Performance & reliability

- Keep main process responsive: no sync I/O; large operations in workers/utility process.
- Hardware acceleration on by default with a settings toggle and automatic safe-mode relaunch after repeated GPU process crashes (`child-process-gone` events) — GPU bugs are a top source of "black video" reports.
- Memory: close stream tiles/decoders when not displayed; renderer reload recovery with state restore (rejoin voice prompt).
- Crash handling: local crash dumps stored in user-data, **no automatic upload** (privacy); a "Copy diagnostics" button for bug reports.
- Logging: electron-log to rolling files (redacting tokens), "Open logs folder" command.

## 8. Updates and release channels

- `electron-updater` (or Forge's equivalents) reading from GitHub Releases or a Host-independent static location. Channels: `stable`, `beta`.
- Update flow: background check on launch and every ~6 h → download → "Restart to update" prompt; never force-restart mid-call; delay install while in a voice session.
- Signature verification: macOS and Windows code signatures verified by the platform/updater; also publish SHA-256 sums; releases built reproducibly in CI from tagged commits (16).
- Server/client compatibility: updates are needed when `apiVersion` bumps; `CLIENT_TOO_OLD` triggers an immediate update check.
- Downgrade protection: updater refuses lower versions unless explicitly allowed.
- Self-hosted updater endpoints are out of scope; releases come from the project's distribution channel. (AGPL: corresponding source link in About and in release notes.)

## 9. Build & packaging

- Monorepo `apps/desktop` builds main + preload with esbuild/Vite; `apps/web` provides the renderer bundle copied into the app resources.
- Packager: `electron-builder` (broad target support, auto-update integration) or Electron Forge; decide at scaffold (default recommendation electron-builder).
- CI builds on native runners per OS (Windows, macOS, Linux) to sign and notarise; artifacts uploaded to a draft release.
- ASAR packing with integrity; unused locales stripped; installer size target < ~120 MB.
- Third-party notices and AGPL licence text bundled; "Source code" link in About (F1).
- Reproducible build metadata: commit hash and build date in About.

## 10. Testing (desktop-specific; overall plan in 16)

- Playwright with Electron for launch, navigation, deep links, tray actions, IPC validation.
- Unit tests for IPC handlers (sender/arg validation rejects bad input).
- Manual/semiautomated matrix: Win 10/11, macOS (Intel + Apple silicon, two latest majors), Ubuntu (X11 and Wayland), Fedora/GNOME Wayland, KDE Wayland; scenarios: screenshare with/without audio, global mute shortcuts, sleep/wake, device hot-plug, network switch, update install.
- Security tests: attempt navigation to remote URL, `window.open`, IPC from foreign frames, prototype pollution via bridge args.

## 11. Risks (see also 18)

K-05 Wayland capture/hotkeys · K-06 macOS system audio · K-07 hardening mistakes ·
K-14 signing cost · GPU driver quirks ·
Chromium upgrade cadence (Electron security updates must be tracked and released
within days; automation: Renovate/Dependabot + release checklist).

## Open items
- electron-builder vs Forge final choice.
- Pop-out implementation (T14).
- Which Linux packaging formats are first-class at v1 (recommend AppImage + deb; Flatpak after).
- Whether to include simultaneous multi-instance connections in v1 (assumed no).
- Native denoiser utility process (post-v1).
- Hardware-accelerated encode/decode toggles per OS (investigate with D3).
