# Wireframes: voice, video and screen share

> Status: **DRAFT, awaiting approval** (18 T23). Review table, legend and the calls
> marked **U1–U16** are in [README.md](README.md).

Screens W-10 to W-17. Each frame is the **main column** of [W-01](wireframes-main.md#w-01-main-layout)
(the rail and channel list stay on the start side). While a stream view is open the member
list hides itself; the header toggle brings it back.

Ground rules from 08 and 12 that every screen here follows:
- Video never downloads until you choose to watch (R-041, 08 §4.2). Audio from a stream follows its video.
- Leaving a stream view stops the download unless the stream is popped out (U3, 12 §6.1).
- Whoever shares sees who is watching; viewers are told so once (R-046, 08 §5.6).
- Stream audio has its own volume, separate from the person's voice (R-047, 08 §5.7).
- Publisher upload does not grow with viewers, and the UI says so where people choose quality (G4, 08 §5).

## W-10 Call view

Status: Draft · Trace: R-030–R-033, R-040, R-041 · Calls: U2

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ ◄) Lounge · 5 people · [E2E]                            [Back to #general] │
├────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐ │
│ │                      │ │                      │ │                      │ │
│ │  Ann is sharing      │ │                      │ │                      │ │
│ │  their screen        │ │         ◙(A)         │ │         (B)          │ │
│ │                      │ │                      │ │                      │ │
│ │  [Watch stream]      │ │                      │ │                      │ │
│ │ Ann · Screen    LIVE │ │ Ann                  │ │ Bo (m)               │ │
│ └──────────────────────┘ └──────────────────────┘ └──────────────────────┘ │
│ ┌──────────────────────┐ ┌──────────────────────┐                          │
│ │░░░░░░░░░░░░░░░░░░░░░░│ │                      │                          │
│ │░░░░░░░░░░░░░░░░░░░░░░│ │                      │                          │
│ │░░░░░░░░░░░░░░░░░░░░░░│ │         (C)          │                          │
│ │░░░░░░░░░░░░░░░░░░░░░░│ │    [Watch camera]    │                          │
│ │░░░░░░░░░░░░░░░░░░░░░░│ │                      │                          │
│ │ Mika (you)           │ │ Cy               CAM │                          │
│ └──────────────────────┘ └──────────────────────┘                          │
│                                                                            │
│                  [M] [D] [Camera] [Share screen] [Leave]                   │
└────────────────────────────────────────────────────────────────────────────┘
```

- Opens when you select the voice channel you are in, or the channel name in the voice panel (U2). "Back to #general" returns to the last text channel; the call continues.
- Tiles keep their place; the speaking ring moves, the tiles do not (no reordering by active speaker, so nothing jumps).
- Your own camera shows as a local preview (no download). Other cameras show the avatar and "Watch camera" until you watch, unless "Auto-watch cameras" is on (08 §4.2, Video settings).
- A screen share appears as its own tile next to the person's avatar tile.
- Tile focus: Tab reaches the tiles grid (one stop, arrow keys inside); Enter on a stream tile opens the stream view; Shift+F10 opens the participant menu ([W-06](wireframes-main.md#w-06-voice-panel-and-user-panel)).
- The control bar repeats the voice panel controls at a larger size; Share screen is absent where capture is unsupported (mobile web) and disabled with a reason without the Share screen permission.

## W-11 Stream view: focus

Status: Draft · Trace: R-041, R-044, R-045, R-047, 08 §5.4 · Calls: U3

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◄) Lounge · Ann's screen                     [Focus|Grid] [Back to #general] │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │ Ann · Screen · 1080p 30fps  [E2E]                  (eye) You're watching │ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │ Volume ──●── 80%  [Mute] [Auto ▼] [Pop out] [Fullscreen] [Stop watching] │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐                  │
│ │    ◙(A)    │ │    (B)     │ │░░░░░░░░░░░░│ │    (C)     │                  │
│ │ Ann        │ │ Bo (m)     │ │ Mika (you) │ │ Cy  [Watch]│                  │
│ └────────────┘ └────────────┘ └────────────┘ └────────────┘                  │
│                                                                              │
│                   [M] [D] [Camera] [Share screen] [Leave]                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- The stream controls appear on hover and whenever focus is inside the tile; they never cover the bottom of the content permanently.
- **Volume** is the stream's own audio (R-047), saved per sharer on this device. **Mute** mutes only the stream audio.
- **Quality** offers Auto, High, Low and Pause video (08 §5.4). Auto follows the tile size; fullscreen and pop-out ask for a higher layer.
- **(eye) You're watching** reminds viewers that the sharer can see them (R-046); the first time it shows the notice in [W-14](#w-14-watch-opt-in).
- **Pop out** opens [W-17](#w-17-pop-out-and-picture-in-picture); **Fullscreen** uses the browser/OS fullscreen; **Stop watching** unsubscribes and returns to the call view.
- The filmstrip shows everyone else in the call; other live streams carry Watch. Watching a second stream switches to the grid layout.
- "Stats for nerds" (codec, resolution, bitrate, loss, candidate type) is in the tile's More menu (12 §6.3).

## W-12 Stream view: grid

Status: Draft · Trace: R-041, R-044

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◄) Lounge · 2 streams, 1 camera              [Focus|Grid] [Back to #general] │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────┐ ┌────────────────────────────────────┐│
│ │ Ann · Screen                       │ │ Cy · Screen                        ││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░││
│ │ Volume ─●─ 80%  [Mute]     [Focus] │ │                                    ││
│ └────────────────────────────────────┘ └────────────────────────────────────┘│
│ ┌────────────────────────────────────┐ ┌────────────────────────────────────┐│
│ │ Mika (you) · Camera                │ │ Bo                                 ││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │                                    ││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │                                    ││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │                ◙(B)                ││
│ │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │                                    ││
│ │                                    │ │                                    ││
│ └────────────────────────────────────┘ └────────────────────────────────────┘│
│                                                                              │
│                   [M] [D] [Camera] [Share screen] [Leave]                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Order: watched screens first, then cameras, then avatars of people with neither. Order changes only when someone starts or stops a stream.
- Each tile keeps its own controls (shown on hover or focus). Focus on a tile moves to focus mode with that stream.
- Adaptive stream asks for smaller layers in the grid, so watching several streams costs less download than it looks.

## W-13 Sharing bar and viewer list

Status: Draft · Trace: R-043, R-046, 08 §5.2, §5.6

```text
┌─ Sharing bar (top of the main column, in every view, while you share) ───────┐
│ LIVE  You're sharing: Window · Figma — design.fig             [Stop sharing] │
│ (A)(B) Ann and Bo are watching ▼     1080p 30fps · about 4 Mbps up  [Change] │
└──────────────────────────────────────────────────────────────────────────────┘
```

```text
┌─ Watching your screen (2) ───────────────┐   ┌─ Change stream settings ───────────────────┐
│ (A) Ann                                  │   │ Quality    (•) Standard 1080p 30fps        │
│ (B) Bo                                   │   │            ( ) Smooth 1080p 60fps          │
├──────────────────────────────────────────┤   │            ( ) Low upload 720p 15fps       │
│ Viewers are reported by their own apps,  │   │ Optimise   (•) Text and detail             │
│ so this list may be incomplete.          │   │            ( ) Motion and video            │
└──────────────────────────────────────────┘   │ [x] Share audio                            │
                                               ├────────────────────────────────────────────┤
                                               │ About 4 Mbps up, however many people watch.│
                                               └────────────────────────────────────────────┘
```

- The bar sits at the top of the main column in every view except settings, for as long as you share. "Stop sharing" is also in the voice panel and the tray menu (13 §4.1).
- The viewer list uses `Intl.ListFormat` ("Ann and Bo are watching", "Ann, Bo and 3 others are watching"); the popover lists everyone. The disclaimer is the honest limit from 08 §5.6.
- "Change" edits the preset, the content hint and audio while live, within the server's cap (08 §5.2). The upload estimate updates as you pick, and says it does not depend on the number of viewers.
- When both camera and screen are live, the bar shows both and the summed upload estimate (08 §5.2).
- Screen readers hear viewer changes through a polite live region ("Bo started watching"), rate-limited.

## W-14 Watch opt-in

Status: Draft · Trace: R-041, R-046 · Calls: U15

```text
┌─ Ann · Screen · LIVE ────────────────────────────┐   ┌─ Shown once, next to the eye icon ───────┐
│                                                  │   │ Ann can see that you're watching.        │
│           Ann is sharing their screen            │   │ People who share can see who is watching │
│                                                  │   │ their stream.                            │
│                  [Watch stream]                  │   │                                          │
│                                                  │   │                                 [Got it] │
│   Streams don't download until you watch them.   │   └──────────────────────────────────────────┘
│                                                  │
└──────────────────────────────────────────────────┘
```

- Live streams arrive as this placeholder, never as video. The same "Watch" action exists on the LIVE badge in the channel list and member list.
- The notice appears once per device, the first time you watch anyone (U15). It does not block the stream and closes with Esc or "Got it".
- If you aren't in the voice channel, Watch first joins it (with the mic state from the user panel).

## W-15 Desktop source picker

Status: Draft · Trace: R-042, R-043, 13 §4.1, 09 §7, K-05, K-06, T15

```text
┌─ Share your screen ────────────────────────────────────────────────────────── [×] ─┐
│ Screens    Windows                                                                 │
│            ───────                                                                 │
│ ┌────────────────────────┐  ┌────────────────────────┐  ┌────────────────────────┐ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│  │░░░░░░░░░░░░░░░░░░░░░░░░│ │
│ │ (•) Figma — design.fig │  │ ( ) Firefox — Tin Can… │  │ ( ) Terminal           │ │
│ └────────────────────────┘  └────────────────────────┘  └────────────────────────┘ │
│ [ ] Show Tin Can's own windows                                                     │
│                                                                                    │
│ Quality       (•) Standard 1080p30  ( ) Smooth 1080p60  ( ) Low upload 720p15      │
│ Optimise for  (•) Text and detail   ( ) Motion and video                           │
│ [x] Share audio   [ Only Figma's audio                 ▼ ]                         │
│     Sharing all system audio during a call can echo other people's voices.         │
│ [x] Pause my notifications while sharing                                           │
│                                                                                    │
│ Uses about 4 Mbps of upload, however many people watch.         [Cancel] [Go live] │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Platform and server variants:

```text
┌─ macOS without system audio ───────────────────────────────────────────────────────┐
│ [ ] Share audio   (not available on this version of macOS)                         │
└────────────────────────────────────────────────────────────────────────────────────┘
┌─ Preset above the server cap ──────────────────────────────────────────────────────┐
│ Quality       (•) Standard 1080p30  ( ) Smooth 1080p60  ( ) Low upload 720p15      │
│                                     Smooth isn't allowed on this server.           │
└────────────────────────────────────────────────────────────────────────────────────┘
┌─ Linux (X11), or Windows without per-app capture ──────────────────────────────────┐
│ [x] Share audio   [ System audio                       ▼ ]                         │
└────────────────────────────────────────────────────────────────────────────────────┘
```

On Wayland the system portal chooses the source, so Tin Can asks only for the options:

```text
┌─ Share your screen (Wayland) ────────────────────── [×] ─┐
│ Your desktop will ask which screen or window to share.   │
│                                                          │
│ Quality       (•) Standard  ( ) Smooth  ( ) Low upload   │
│ Optimise for  (•) Text and detail  ( ) Motion            │
│ [x] Share audio if your system allows it                 │
│                                                          │
│                                      [Cancel] [Continue] │
└──────────────────────────────────────────────────────────┘
```

- Tabs: Screens and Windows. Cards are radio items (one tab stop, arrow keys move, Enter goes live). Thumbnails refresh about once a second while the picker is open (13 §4.1).
- Tin Can's own windows are hidden unless the checkbox is ticked (avoids the mirror tunnel).
- Quality presets come from `publishDefaults`; presets above the server cap show disabled with the reason (08 §5.2).
- "Optimise for" sets the content hint: Text and detail (default) or Motion and video (08 §5.2).
- Audio: Windows offers per-app audio where supported, otherwise system audio; system audio shows the echo warning (09 §7, T15). macOS without system-audio support shows the checkbox disabled with the reason (K-06).
- "Pause my notifications while sharing" defaults on (13 §4.1).
- The upload estimate matches the chosen preset and states that it doesn't grow with viewers.
- If the user cancels the OS portal on Wayland, nothing happens and no error shows (K-05).

## W-16 Web screen share

Status: Draft · Trace: R-042, R-043, 12 §6.3

```text
┌─ Share your screen (web) ────────────────────────── [×] ─┐
│ Quality       (•) Standard  ( ) Smooth  ( ) Low upload   │
│ Optimise for  (•) Text and detail  ( ) Motion            │
│                                                          │
│ Next, your browser asks what to share. To include sound, │
│ share a tab and turn on the browser's audio option.      │
│                                                          │
│                                      [Cancel] [Continue] │
└──────────────────────────────────────────────────────────┘
```

- The browser shows its own picker after this step; Tin Can cannot list sources on the web.
- Tab audio is the only reliable audio source in browsers; the copy says how to include it without naming browser-specific labels.
- Mobile browsers hide Share screen entirely (12 §14).

## W-17 Pop-out and picture-in-picture

Status: Draft · Trace: R-045, 13 §4.6, T14

```text
┌─ Ann's screen ───────────────────────────── [×] ─┐   ┌─ Main window, where the stream was ──┐
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │                                      │
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │     Ann's screen is in a pop-out     │
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │                                      │
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │           [Bring it back]            │
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │                                      │
│ Volume ──●── 80%  [Mute]           [Back to app] │   └──────────────────────────────────────┘
└──────────────────────────────────────────────────┘
```

- Desktop: an always-on-top window that keeps playing while you chat in the main window. The implementation (Document Picture-in-Picture first, full pop-out window later) waits on spike T14; the frame is the same for both.
- The main window shows a placeholder where the stream was, with "Bring it back".
- Web: the same button uses the browser's picture-in-picture where available, and is hidden otherwise.

## Open items

- Split view (chat beside a stream) for v1.1? (U3 keeps v1 simpler.)
- "Auto-watch cameras" default (off proposed).
- Whether the call view should show a text-channel shortcut for paired channels (admins pair them by name today, 18 Q5).
