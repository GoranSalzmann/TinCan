# Wireframes: narrow windows and mobile web

> Status: **Approved 2026-10-28** (18 T23). Review table, legend and the calls
> marked **U1–U16** are in [README.md](README.md).

Screens W-50 to W-55: how the layout collapses (12 §14). There is no native mobile app
(01 §4); phones use the web client, so these frames have no instance rail (U5).

| Breakpoint | Width | Channel list | Member list | Voice controls |
|---|---|---|---|---|
| compact | < 768 px | Drawer from the start edge (W-51) | Bottom sheet (W-52) | Bottom bar, expanding to a sheet (W-53) |
| medium | 768–1279 px | Docked | Overlay from the end edge (W-55) | Voice panel |
| wide | ≥ 1280 px | Docked | Docked, hideable (W-01) | Voice panel |

On coarse pointers every hit target is at least 44 px (style guide §6), whatever the width.
Capability detection hides what mobile browsers can't do (screen sharing, global shortcuts,
background audio guarantees, 12 §14).

## W-50 Compact: channel

Status: Approved · Trace: 12 §14

```text
┌──────────────────────────────────────┐
│ [≡]  # general             [Members] │
├──────────────────────────────────────┤
│ (A) Ann                        10:41 │
│     has anyone tried the new build?  │
│ (B) Bo                         10:43 │
│     yep, sharing my screen in        │
│     Lounge now                       │
│ ─────────────── New ──────────────── │
│┃(C) Cy                         10:52 │
│┃    @Mika can you look at the        │
│┃    invite?                          │
│                                      │
│                                      │
├──────────────────────────────────────┤
│ [+]  Message #general         [Send] │
├──────────────────────────────────────┤
│ ◄) Lounge · Connected        [M] [▲] │
└──────────────────────────────────────┘
```

With the on-screen keyboard open:

```text
┌─ Keyboard open: bottom bar hidden ───┐
│ [≡]  # general             [Members] │
├──────────────────────────────────────┤
│  …messages…                          │
├──────────────────────────────────────┤
│ [+]  hey everyone|            [Send] │
├──────────────────────────────────────┤
│         (on-screen keyboard)         │
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
└──────────────────────────────────────┘
```

- Top bar: `[≡]` opens the channel drawer, the title is the channel name, `[Members]` opens the member sheet.
- The voice bottom bar appears only while connected: channel, state, mute, and `[▲]` to open the voice sheet.
- When the keyboard opens, the bottom bar hides so the composer sits on the keyboard; it returns when the keyboard closes.
- Message actions open from a long press **and** from a visible "More" button on the focused message (no gesture-only actions).
- Safe areas: content respects `env(safe-area-inset-*)` on phones with notches and home indicators.

## W-51 Compact: channel drawer

Status: Approved · Trace: 12 §14

```text
┌───────────────────────────┬──────────┐
│ Friends of Tin          ▼ │▒▒▒▒▒▒▒▒▒▒│
├───────────────────────────┤▒▒▒▒▒▒▒▒▒▒│
│ ▼ Text channels           │▒▒▒▒▒▒▒▒▒▒│
│▌  # general               │▒▒▒▒▒▒▒▒▒▒│
│•  # random                │▒▒▒▒▒▒▒▒▒▒│
│•  # links             [2] │▒▒▒▒▒▒▒▒▒▒│
│ ▼ Voice channels          │▒▒▒▒▒▒▒▒▒▒│
│   ◄) Lounge  [E2E]        │▒▒▒▒▒▒▒▒▒▒│
│      ◙ Ann           LIVE │▒▒▒▒▒▒▒▒▒▒│
│      ○ Bo             (m) │▒▒▒▒▒▒▒▒▒▒│
│   ◄) Gaming               │▒▒▒▒▒▒▒▒▒▒│
│                           │▒▒▒▒▒▒▒▒▒▒│
│                           │▒▒▒▒▒▒▒▒▒▒│
├───────────────────────────┤▒▒▒▒▒▒▒▒▒▒│
│ (M) Mika        [M][D][S] │▒▒▒▒▒▒▒▒▒▒│
│     ● Online              │▒▒▒▒▒▒▒▒▒▒│
└───────────────────────────┴──────────┘
```

- Slides in from the inline start (right in RTL) to at most 85% of the width, over a scrim.
- Closes by choosing a channel, tapping the scrim, Esc, the back gesture or a swipe; focus is trapped while open and returns to `[≡]`.
- Contains the instance menu, channel list with voice presence, and the user panel. Joining a voice channel closes the drawer.

## W-52 Compact: member sheet

Status: Approved · Trace: 12 §14

```text
┌──────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
├──────────────────────────────────────┤
│                 ────                 │
│ Members — 12                     [×] │
│ Admin — 1                            │
│  ● (M) Mika                          │
│ Moderator — 1                        │
│  ● (B) Bo                         ◄) │
│ Online — 2                           │
│  ● (A) Ann                      LIVE │
│  ◦ (C) Cy                            │
│ Offline — 8                          │
│  ○ (D) Dee                           │
│  …                                   │
└──────────────────────────────────────┘
```

- A bottom sheet at half height that can be dragged to full height; `[×]`, Esc and the scrim close it (dragging is never the only way).
- Tapping a member opens the user card as a second sheet.

## W-53 Compact: voice sheet

Status: Approved · Trace: 12 §14, R-032

```text
┌──────────────────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
├──────────────────────────────────────┤
│                 ────                 │
│ ◄) Lounge · [E2E]                [×] │
│ ▪▪▪ Good · 34 ms                     │
│                                      │
│  ◙ (A) Ann              LIVE [Watch] │
│  ○ (B) Bo   (m)                      │
│  ○ (M) Mika (you)                    │
│                                      │
│  [ Mute ]   [ Deafen ]   [ Camera ]  │
│  [          Leave voice          ]   │
│                                      │
│  Keep this tab open to stay in the   │
│  call. Screen sharing isn't          │
│  available in mobile browsers.       │
└──────────────────────────────────────┘
```

- Opened from the bottom bar. Large controls (44 px or more); Leave is separate from the others so it isn't hit by accident.
- Share screen is absent; the note explains once, together with the reminder to keep the tab open (mobile browsers may pause background audio).
- Watch opens the stream view (W-54).

## W-54 Compact: stream view

Status: Approved · Trace: R-041, R-047

```text
┌─ Portrait ───────────────────────────┐   ┌─ Landscape, fullscreen ────────────────────────────────┐
│ [←] Ann's screen                     │   │ [←] Ann's screen                  Tap to show controls │
├──────────────────────────────────────┤   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│ Volume ──●── 80%  [Mute]      [Full] │   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
├──────────────────────────────────────┤   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│  ◙(A) Ann    (B) Bo (m)    (M) You   │   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│                                      │   │ Volume ──●── 80%  [Mute]             [Exit fullscreen] │
├──────────────────────────────────────┤   └────────────────────────────────────────────────────────┘
│ ◄) Lounge · Connected        [M] [▲] │
└──────────────────────────────────────┘
```

- Portrait: the stream sits at the top at its aspect ratio, people below, bottom bar at the bottom.
- Landscape or the Full button: fullscreen with controls that appear on tap and hide after a few seconds (they stay while focused).
- Stream volume is the same separate control as on desktop (R-047).

## W-55 Medium: member overlay

Status: Approved · Trace: 12 §14 · Calls: U8

```text
┌──────┬───────────────────────┬──────────────────────────────────────────────────────────┐
│ ┌──┐ │ Friends of Tin      ▼ │ # general                             [Search] [Members] │
│▌│FT│ ├───────────────────────┼──────────────────────────────────────────────────────────┤
│ └──┘ │ ▼ Text channels       │ (A) Ann                    10:41 ┃ Members           [×] │
│ ┌──┐ │▌  # general           │     has anyone tried the new     ┃ Admin — 1             │
│ │+ │ │•  # random            │     build?                       ┃  ● (M) Mika           │
│ └──┘ │ ▼ Voice channels      │ (B) Bo                     10:43 ┃ Moderator — 1         │
│      │   ◄) Lounge  [E2E]    │     yep, sharing my screen       ┃  ● (B) Bo     ◄)      │
│      │      ◙ Ann    LIVE    │                                  ┃ Online — 2            │
│      │                       │                                  ┃  ● (A) Ann   LIVE     │
│      ├───────────────────────┤                                  ┃  ◦ (C) Cy             │
│      │ ◄) Lounge   ▪▪▪ 34 ms │                                  ┃                       │
│      │ [Cam] [Share] [Leave] │                                  ┃                       │
│      ├───────────────────────┤                                  ┃                       │
│      │ (M) Mika    [M][D][S] │ [+]  Message #general            ┃                       │
└──────┴───────────────────────┴──────────────────────────────────────────────────────────┘
```

- Desktop app at medium width (the web version has no rail). The member list opens over the end of the message list from the header toggle and closes with `[×]` or Esc (U8).
- The overlay doesn't push or narrow the message list, so the reading position stays put.

## Open items

- Whether compact gets a simple swipe-from-the-edge gesture to open the drawer (in addition to `[≡]`).
- Tablet landscape (≥ 1024 px, touch) could dock the member list; currently it follows width only.
