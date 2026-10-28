# Wireframes: settings

> Status: **DRAFT, awaiting approval** (18 T23). Review table, legend and the calls
> marked **U1–U16** are in [README.md](README.md).

Screens W-20 to W-26: the settings shell and the pages the M0 brief asked for (Voice & audio,
Keybinds, Storage, Devices & sessions), the connection test, and Appearance, where the style
guide's themes become visible. Other pages (Profile, Notifications, Video, Streaming,
Language, Advanced, About) reuse these patterns and are listed in the README as not drawn.

## W-20 Settings shell

Status: Draft · Trace: 12 §8, 11 §4 · Calls: U9

```text
┌─────────────────────────┬────────────────────────────────────────────────────────────────────────┐
│ User settings           │ Voice & audio                                                  [× Esc] │
│   My account            ├────────────────────────────────────────────────────────────────────────┤
│   Profile               │                                                                        │
│   Devices & sessions    │ (selected page: W-21 to W-26)                                          │
│   Appearance            │                                                                        │
│   Notifications         │ Content column is at most 46rem wide and starts at the inline start.   │
│▌  Voice & audio         │                                                                        │
│   Video                 │ Server settings appear only for members with at least one admin        │
│   Keybinds              │ permission; each page appears only with its own permission.            │
│   Streaming             │                                                                        │
│   Storage               │ The bottom of the navigation keeps voice controls while you are in a   │
│   Language              │ call, because settings cover the voice panel.                          │
│   Advanced              │                                                                        │
│   About                 │                                                                        │
│ Server settings         │                                                                        │
│   Overview              │                                                                        │
│   Channels              │                                                                        │
│   Roles                 │                                                                        │
│   Members               │                                                                        │
│   Invites               │                                                                        │
│   Audit log             │                                                                        │
│   Modules & status      │                                                                        │
├─────────────────────────┤                                                                        │
│   Log out               │                                                                        │
├─────────────────────────┤                                                                        │
│ ◄) Lounge [M][D][Leave] │                                                                        │
└─────────────────────────┴────────────────────────────────────────────────────────────────────────┘
```

- Settings is a full-screen layer over the app (U9): voice keeps running, and the bottom of the navigation keeps mute, deafen and leave while you are in a call.
- Esc or `[× Esc]` closes settings and returns focus to whatever opened it. Each page has its own URL (`/settings/voice`) so links and the back button work.
- Pages come from modules (12 §8 `settingsPane` slot); a disabled module's page is absent, not greyed.
- Synced settings carry a small "Synced" note; device-local ones don't (12 §8).
- About holds the version, server version, licences and the **Source code** link (F1, AGPL).
- Compact width: navigation becomes its own screen and pages open on top of it with a back button.

## W-21 Voice & audio

Status: Draft · Trace: R-034, R-035, 09 §6, §9, §10

```text
┌─ Voice & audio ──────────────────────────────────────────────────────────────────┐
│ Input device     [ Default — USB Microphone (Yeti)            ▼ ]                │
│ Output device    [ Default — Headphones (Realtek)             ▼ ]                │
│ Input level      ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░│░   Clipping marker at the end │
│ Input gain       ──────────────●──────────────   +0 dB                           │
│                                                                                  │
│ Test your microphone                                                             │
│   [Record 5 s]  [Play back]       Hear it with processing:  (•) On  ( ) Off      │
│   [ ] Listen to myself live  (use headphones; adds a little delay)               │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Sound profile                                                                    │
│   [▌Standard ]  [ Aggressive ]  [ Natural ]  [ Studio / Music ]  [ Custom ]      │
│   Best for most people. Removes background noise and evens out your level.       │
│                                                                                  │
│ ▼ Advanced                                                                       │
│     Noise suppression   [ DeepFilterNet (best quality)                 ▼ ]       │
│     Strength            ──────────────────────●──────   80%                      │
│     Noise gate          [ off ]    Threshold ────●────   Hold 200 ms             │
│     Automatic gain      [ on  ]                                                  │
│     Echo cancellation   [ on  ]    (only Studio / Music and Custom turn it off)  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Transmit mode   (•) Voice activity    ( ) Push to talk                           │
│   Sensitivity   ▓▓▓▓▓▓▓▓▓▓░░░░░░│░░░░░░░░░░░░   [x] Set automatically            │
│   Push to talk  Key [ F ] [Change]   Release delay ──●── 200 ms   [x] Cue sounds │
│   Hold-to-talk works while Tin Can is focused. In games, use voice activity      │
│   with a global mute shortcut (Keybinds).                                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Noise suppression: DeepFilterNet · CPU 4% · added delay 22 ms                    │
│ [Stats for nerds]                         Trouble connecting?  [Test connection] │
└──────────────────────────────────────────────────────────────────────────────────┘
```

States and variants:

```text
┌─ Mic test: recording ────────────────────────────────────────────────────────────┐
│   Recording…  ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░  3 s left             [Stop]              │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Mic test: A/B playback ─────────────────────────────────────────────────────────┐
│   Playing back with processing ON   ▓▓▓▓▓▓▓░░░░░░░░    [Switch to OFF]  [Stop]   │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Studio / Music selected ────────────────────────────────────────────────────────┐
│   [ Standard ]  [ Aggressive ]  [ Natural ]  [▌Studio / Music ]  [ Custom ]      │
│   (!) Echo cancellation and noise suppression are off. Use headphones,           │
│       or other people will hear themselves.                                      │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Host forbids Studio ────────────────────────────────────────────────────────────┐
│   [ Studio / Music ]  disabled: Your server doesn't allow Studio / Music.        │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ No Use voice activity permission ───────────────────────────────────────────────┐
│   ( ) Voice activity  disabled: This channel requires push to talk.              │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Web ────────────────────────────────────────────────────────────────────────────┐
│   Push to talk only works while Tin Can is the focused browser tab.              │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Devices:** pickers list devices by name; the system default is first and labelled. Unplugging the chosen device falls back to the default with a toast ([W-07](wireframes-main.md#w-07-banners-toasts-and-blocking-screens)); plugging it back in switches back (12 §6.1).
- **Meter:** live input level after processing, with a clipping marker at the end (09 §9). The voice-activity threshold appears on the sensitivity meter so people can see where it triggers.
- **Mic test:** record 5 seconds, then play back with processing On or Off to hear what the denoiser does (09 §9). Recordings stay in memory and are discarded (09 §11).
- **Listen to myself:** live loopback; asks for headphones first and warns about the delay.
- **Sound profile** is the preset (09 §6) as a segmented control; the sentence under it describes the selected one. Changing any Advanced control switches the profile to Custom.
- **Advanced** is collapsed by default. Noise suppression options: DeepFilterNet (best quality), RNNoise (lighter, if shipped, T16), Browser built-in, Off.
- **Transmit mode:** voice activity with sensitivity, or push to talk with key, release delay (default 200 ms) and cue sounds (09 §10). The note explains the v1 limit on global hold-to-talk (13 §4.2).
- **Status line:** current denoiser, its CPU share and the added delay (09 §9). When the runtime guard downgrades the denoiser, a toast says so and this line shows why (09 §3).
- The page reads the same whether or not you are in a call; changes apply live.

## W-22 Keybinds

Status: Draft · Trace: R-035, 13 §4.2, K-20

```text
┌─ Keybinds ───────────────────────────────────────────────────────────────────────┐
│ In-window shortcuts work while Tin Can is focused. Global shortcuts also work    │
│ while another app, such as a game, is focused (desktop app only).                │
│                                                                                  │
│ Action                  In window                 Global                         │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ Push to talk (hold)     [ F ]                     Not available  (i)             │
│ Toggle mute             [ Ctrl+Shift+M ]          [ Ctrl+Alt+M ]                 │
│ Toggle deafen           [ Ctrl+Shift+D ]          [ Record… ]                    │
│ Leave voice             [ Record… ]               [ Ctrl+Alt+L ]                 │
│ Next unread channel     [ Alt+Shift+Down ]        —                              │
│ Quick switcher          [ Ctrl+K ]                —                              │
│                                                                                  │
│ [Reset to defaults]                                                              │
└──────────────────────────────────────────────────────────────────────────────────┘
```

States and platform variants:

```text
┌─ Recording ──────────────────────────────────────────────────────────────────────┐
│ Toggle deafen           [ Press keys… ]                                          │
│   Esc cancels · Backspace clears · mouse buttons 4 and 5 work too                │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Conflict ───────────────────────────────────────────────────────────────────────┐
│ (!) Ctrl+Shift+M is already used by Toggle mute.                                 │
│     [Use it for Toggle deafen instead]  [Cancel]                                 │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Global shortcut refused by the OS ──────────────────────────────────────────────┐
│ (!) Couldn't set Ctrl+Alt+M as a global shortcut. Another app may be using it.   │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Linux, Wayland session ─────────────────────────────────────────────────────────┐
│ Global shortcuts aren't available in this desktop session. Bind these            │
│ commands to keys or mouse buttons in your desktop's keyboard settings:           │
│   tincan --toggle-mute      [Copy]                                               │
│   tincan --toggle-deafen    [Copy]                                               │
│   tincan --leave            [Copy]                                               │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ Web (Global column hidden) ─────────────────────────────────────────────────────┐
│ Shortcuts work while this tab is focused. The desktop app adds shortcuts         │
│ that work in games.  [Get the desktop app]                                       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Two columns: **In window** (web and desktop) and **Global** (desktop only, Electron `globalShortcut`, 13 §4.2.1).
- Global push to talk says "Not available" with an info tooltip: hold-to-talk while a game is focused is not in v1; voice activity plus a global mute shortcut is the suggested setup (13 §4.2.2).
- The recorder accepts key combinations and mouse buttons 4 and 5 (in-window), shows conflicts before saving, and reports when the OS refuses a global shortcut.
- Wayland sessions (and any Linux session where registration fails) show the `tincan --toggle-mute` style commands with Copy buttons (13 §4.2.1).
- Shortcut labels follow the OS (Ctrl on Windows and Linux, Cmd on macOS).

## W-23 Storage

Status: Draft · Trace: R-021, 07 §3.7 · Calls: U16

```text
┌─ Storage ────────────────────────────────────────────────────────────────────────┐
│ Your uploads                                                                     │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░   1.2 GB of 2 GB used                   │
│ Files you upload count toward this limit. Deleting a message with a file frees   │
│ that space. Your server admin sets the limit.                                    │
│                                                                                  │
│ Largest uploads                                                   [Sort: Size ▼] │
│ File                      Channel       Date      Size                           │
│ ──────────────────────────────────────────────────────────────────────────────── │
│ trip-video.mp4            #random       12 Mar    412 MB    [Jump] [Delete]      │
│ band-practice.wav         #music        2 Mar     188 MB    [Jump] [Delete]      │
│ screenshot.png            #general      14 Mar    1.4 MB    [Jump] [Delete]      │
│ …                                                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

```text
┌─ Near the limit (90% or more) ───────────────────────────────────────────────────┐
│ (!) You've used 1.9 GB of 2 GB. Large files may not fit.                         │
└──────────────────────────────────────────────────────────────────────────────────┘
┌─ At the limit ───────────────────────────────────────────────────────────────────┐
│ (!) You've reached your upload limit. Delete files, or ask an admin for more.    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- The bar shows `usedBytes` of `quotaBytes` from `GET /users/@me/storage` (07 §3.7), formatted with `Intl.NumberFormat` units.
- The "Largest uploads" list needs an endpoint that 07 doesn't have yet (U16). Without it, v1 shows the bar and the explanation only.
- Delete removes the attachment from its message after a confirm; Jump opens the message.
- The instance disk warning (R-021, `diskWarnPercent`) is for admins and lives in Server settings, Overview, not here.

## W-24 Devices & sessions

Status: Draft · Trace: R-005, 11 §1.2

```text
┌─ Devices & sessions ─────────────────────────────────────────────────────────────┐
│ These devices are signed in to your account. Sign out of any you don't           │
│ recognise.                                                                       │
│                                                                                  │
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ Tin Can for Windows                                              This device │ │
│ │ Active now                                                                   │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ Firefox on Linux                                                  [Sign out] │ │
│ │ Last active 2 days ago                                                       │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ Tin Can for macOS                                                 [Sign out] │ │
│ │ Last active 3 weeks ago                                                      │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│ [Sign out of all other devices]                                                  │
│ Changing your password also signs out every other device.                        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

```text
┌─ Confirm ──────────────────────────────────────────┐
│ Sign out of 2 other devices?                       │
│                                                    │
│ They'll need to log in again.                      │
│                                                    │
│                                [Cancel] [Sign out] │
└────────────────────────────────────────────────────┘
```

- One card per session: client name and OS, last active (relative time), and "This device" for the current one. Location stays hidden by default (11 §1.2).
- Sign out revokes that session at once; the other device is returned to its login screen.
- "Sign out of all other devices" confirms first and shows how many devices it affects.
- Changing the password (My account) revokes all other sessions; the page says so here too (11 §1.9).

## W-25 Connection test

Status: Draft · Trace: 08 §10, K-01, 14 §4

```text
┌─ Test connection ────────────────────────────────────────────────────────────────┐
│ Checks whether voice and video can reach Friends of Tin from this network.       │
│                                                                                  │
│ [Run test]                                                                       │
│                                                                                  │
│   [ok]  Server reachable                  OK                                     │
│   [ok]  Microphone allowed                OK                                     │
│   [--]  Camera allowed                    Not asked yet  [Ask now]               │
│   [!!]  Direct connection (UDP)           Blocked                                │
│   [ok]  Backup connection (TCP)           OK                                     │
│   [ok]  Relay (TURN over TLS)             OK                                     │
│                                                                                  │
│   Ping 48 ms · packet loss 0.2% · using: relay                                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Your network blocks the direct path, so Tin Can uses the relay. Calls work       │
│ with a little more delay. This is common on school and work networks.            │
│                                                                                  │
│ [Copy diagnostics]  [Run again]                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

```text
┌─ Running ────────────────────────────────────────────────────────────────────────┐
│   [ok]  Server reachable                  OK                                     │
│   [..]  Direct connection (UDP)           Checking…                              │
│   [  ]  Backup connection (TCP)           Waiting                                │
│   [  ]  Relay (TURN over TLS)             Waiting                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

```text
┌─ Nothing works ──────────────────────────────────────────────────────────────────┐
│ Tin Can can't reach the voice server from this network at all, so voice and      │
│ video won't work here. Text chat still works. Try another network, or send the   │
│ diagnostics to your server admin.  [Copy diagnostics]                            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Reached from Voice & audio, from the voice panel's connection popover, and from the voice-failed states.
- Steps run in order, each with a plain-language status; the result explains what it means in words, not port numbers. Technical details are in "Copy diagnostics" (no data leaves the device unless the user pastes it somewhere).
- Camera permission is not requested unless the user presses "Ask now".
- Reaching the server but not the media paths is the most common case; the copy says text still works (08 §11).

## W-26 Appearance

Status: Draft · Trace: 12 §8, §13, N-011 · Calls: U6

```text
┌─ Appearance ─────────────────────────────────────────────────────────────────────┐
│ Theme           (•) Match system   ( ) Light   ( ) Dark   ( ) High contrast      │
│ Accent          (•) Teal  ( ) Blue  ( ) Violet  ( ) Rose                         │
│                 ( ) Amber  ( ) Green  ( ) Graphite                               │
│                 High contrast uses its own colours.                              │
│ Density         (•) Comfortable   ( ) Compact                                    │
│ Text size       ──────●──────────────   16 px                                    │
│ Reduce motion   [ off ]   Turns on by itself when your system asks for it.       │
│ Animated images (•) Play automatically   ( ) Play on hover or focus              │
│                                                                                  │
│ Preview                                                                          │
│ ┌──────────────────────────────────────────────────────────────────────────────┐ │
│ │ (A) Ann                                                                10:41 │ │
│ │     has anyone tried the new build?                                          │ │
│ │┃    @Mika it fixed the echo thing for me                                     │ │
│ └──────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│ Theme and accent follow you to your other devices.                               │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- Theme options map to the style guide themes (§2); Match system follows `prefers-color-scheme` and `prefers-contrast`.
- Accent presets are radio swatches with names (U6); the high-contrast theme ignores them and says so.
- Text size changes the root size (12–20 px), so the whole UI scales (style guide §5.2).
- Reduce motion is on whenever the OS asks; the switch can turn it on for Tin Can alone.
- The preview updates live, including the mention highlight.

## Open items

- Settings search (useful once all panes exist).
- Whether Video settings get a camera preview with the same test pattern as the mic test.
- The own-attachments endpoint for Storage (U16).
