# Wireframes: main layout

> Status: **DRAFT, awaiting approval** (18 T23). Review table, legend and the calls
> marked **U1–U16** are in [README.md](README.md). Tokens and components: [style-guide.md](style-guide.md).

Screens W-01 to W-07: the window you live in. Drawn at the **wide** breakpoint
(≥ 1280 px, desktop app). Narrower layouts are in [wireframes-mobile.md](wireframes-mobile.md).

## W-01 Main layout

Status: Draft · Trace: 12 §4, R-018, R-031, R-033 · Calls: U1, U2, U5, U8

```text
┌──────┬───────────────────────┬────────────────────────────────────────────────┬──────────────────┐
│ ┌──┐ │ Friends of Tin      ▼ │ # general · anything goes   [Search] [Members] │ Members          │
│▌│FT│ ├───────────────────────┼────────────────────────────────────────────────┼──────────────────┤
│ └──┘ │ ▼ Text channels       │ (A) Ann                                  10:41 │ Admin — 1        │
│  ──  │▌  # general           │     has anyone tried the new build?            │  ● (M) Mika      │
│ ┌──┐ │•  # random            │     it fixed the echo thing for me             │ Moderator — 1    │
│ │GN│ │•  # links       [2]   │                                                │  ● (B) Bo   ◄)   │
│ └──┘ │ ▼ Voice channels      │ (B) Bo                                   10:43 │ Online — 2       │
│ ┌──┐ │   ◄) Lounge  [E2E]    │     yep, sharing my screen in Lounge now       │  ● (A) Ann LIVE  │
│ │+ │ │      ◙ Ann    LIVE    │ ──────────────────── New ───────────────────── │  ◦ (C) Cy        │
│ └──┘ │      ○ Bo  (m)(d)     │┃(C) Cy                                   10:52 │ Offline — 8      │
│      │      ○ Mika           │┃    @Mika can you look at the invite?          │  ○ (D) Dee       │
│      │   ◄) Gaming           │                                                │  ○ (E) Eli       │
│      │      ○ Cy      CAM    │                                                │  …               │
│      │ ► Archive             │                                                │                  │
│      │                       │                                                │                  │
│      │                       │                                                │                  │
│      ├───────────────────────┤                                                │                  │
│      │ ◄) Lounge   ▪▪▪ 34 ms │                                                │                  │
│      │ Voice connected [E2E] │                                                │                  │
│      │ [Cam] [Share] [Leave] │ ┌────────────────────────────────────────────┐ │                  │
│      ├───────────────────────┤ │ [+] Message #general               [Emoji] │ │                  │
│      │ (M) Mika    [M][D][S] │ └────────────────────────────────────────────┘ │                  │
│      │     ● Online          │ Ann is typing…                                 │                  │
└──────┴───────────────────────┴────────────────────────────────────────────────┴──────────────────┘
```

Regions, in F6 order (each is a landmark with a label):

1. **Instance rail** (desktop only, U5). Saved servers; the active one has the start-edge bar. "+" adds a server ([W-34](wireframes-onboarding.md#w-34-saved-servers-switcher)).
2. **Channel list** with the instance menu at the top, then categories, text channels and voice channels with live presence ([W-02](#w-02-channel-list)).
3. **Message list** under the channel header (name, topic, search, member-list toggle) ([W-03](#w-03-message-list)).
4. **Composer** with the typing line under it ([W-04](#w-04-composer)).
5. **Member list**, docked at this width and hideable from the header (U8) ([W-05](#w-05-member-list-and-user-card)).
6. **Voice panel** above the **user panel**, at the bottom of the channel list ([W-06](#w-06-voice-panel-and-user-panel)). The voice panel appears only while connected. Mute and deafen live in the user panel so they work before you join (U1).

Behaviour:
- Selecting a text channel swaps the message list and composer; voice keeps running (12 §6.3).
- Selecting a voice channel joins it at once (U13) and does **not** change the message list (U2). Selecting the voice channel you're in, or its name in the voice panel, opens the call view ([W-10](wireframes-voice-video.md#w-10-call-view)).
- The channel list is resizable (12.5–22.5rem); the width is device-local.
- The reconnecting, offline and update banners sit at the top of the main column ([W-07](#w-07-banners-toasts-and-blocking-screens)).

Right-to-left: the whole layout mirrors. Schematic:

```text
┌────────────────┬────────────────────────────────────┬────────────────┬──────┐
│        Members │                     Channel header │  Instance menu │   FT │
├────────────────┼────────────────────────────────────┼────────────────┤      │
│         Groups │            Messages, start-aligned │       Channels │   GN │
│                │                (right edge in RTL) │                │    + │
│                │                                    │                │      │
│                │                           Composer │    Voice panel │      │
│                │                                    │     User panel │      │
└────────────────┴────────────────────────────────────┴────────────────┴──────┘
```

## W-02 Channel list

Status: Draft · Trace: R-018, R-031, R-033, R-051, 10 §5 · Calls: U13

```text
┌────────────────────────────────┐
│ Friends of Tin               ▼ │  ← Instance menu: invite people, notifications, server settings
├────────────────────────────────┤
│ ▼ Text channels              + │  ← Category; + appears only with Manage channels
│▌  # general                    │  ← Current channel (aria-current)
│•  # random                     │  ← Unread: bold name and a start-edge pill
│•  # links                  [2] │  ← Mentions: count badge, read as "2 mentions"
│   # off-topic          (muted) │  ← Muted channel: dimmed, no pill, badge only for mentions
│ ▼ Voice channels             + │
│   ◄) Lounge   [E2E]            │  ← Encrypted: lock icon, explanation in the tooltip (10 §5)
│      ◙ Ann                LIVE │  ← Speaking ring; LIVE = sharing screen, Enter or click to watch
│      ○ Bo               (m)(d) │  ← Self-muted and deafened icons
│      ○ Mika (you)          CAM │  ← Camera on
│   ◄) Gaming                2/5 │  ← Count shown only when the channel has a user limit
│      ○ Cy                  (M) │  ← Server-muted: filled icon, "Muted by a moderator"
│      ○ Dee                 (…) │  ← Reconnecting: spinner on the avatar (08 §4.4)
│   ◄) Movie night           5/5 │  ← Full: joining disabled, tooltip says why
│ ► Archive                    • │  ← Collapsed category with something unread inside
└────────────────────────────────┘
```

Context menus (right-click, Shift+F10 or the Menu key). Items under the divider appear only with Manage channels:

```text
┌─ # random ─────────────────┐    ┌─ ◄) Lounge ────────────────┐
│ Mark as read               │    │ Join voice                 │
│ Mute channel             ► │    │ Open call view             │
│ Notifications            ► │    │ Copy link                  │
│ Copy link                  │    ├────────────────────────────┤
├────────────────────────────┤    │ Edit channel               │
│ Edit channel               │    │ Permissions                │
│ Permissions                │    │ Move up                    │
│ Move up                    │    │ Move down                  │
│ Move down                  │    │ Delete channel             │
│ Delete channel             │    └────────────────────────────┘
└────────────────────────────┘
```

- Order of a voice participant row: avatar (speaking ring), name, then status icons (muted, deafened, server-muted), then live badges. Badges never hide the name; long names truncate first.
- LIVE and CAM badges are buttons: activating one opens that stream in the stream view ([W-11](wireframes-voice-video.md#w-11-stream-view-focus)) and, if you aren't in the channel, asks to join first.
- Muting a channel (menu) offers 15 minutes, 1 hour, 8 hours, or until turned back on; muted channels show mentions only.
- Reordering by drag also exists as Move up / Move down (style guide §11).
- Loading: three skeleton rows per category. Empty server: admins see "Create a channel", others see "Nothing here yet".
- After a non-resumable reconnect, voice participants are dimmed until the new READY arrives (12 §5.2).

Keyboard: the list is a tree (one tab stop). ↑/↓ move, → expands a category or enters a voice channel's participants, ← collapses or goes to the parent (mirrored in RTL), Enter opens a text channel or joins a voice channel, typing jumps by name, Alt+↑/↓ switches channels from anywhere.

## W-03 Message list

Status: Draft · Trace: R-010–R-020, 12 §5.3–5.6

```text
┌──────────────────────────────────────────────────────────────────┐
│ 12 new messages since 10:40                       [Mark as read] │  ← Unread above the view (sticky)
├──────────────────────────────────────────────────────────────────┤
│ ─────────────────────── Tuesday 14 March ─────────────────────── │  ← Date separator (sticky)
│ (A) Ann                                                    10:41 │
│     has anyone tried the new build?                              │
│     it fixed the echo thing for me  (edited)                     │
│     [:+1: 3] [:tada: 1] [+]                                      │
│   ╭ (A) Ann: it fixed the echo thing for me                      │  ← Reply reference: jumps to it
│ (B) Bo                                [React][Reply][More] 10:43 │  ← Hover or focus: action toolbar
│     yep, sharing my screen in Lounge now                         │
│ ───────────────────────────── New ────────────────────────────── │  ← New messages divider
│┃(C) Cy                                                     10:52 │  ← Mentions you
│┃    @Mika can you check the invite? https://example.com/notes    │
│     ┌──────────────────────┐                                     │
│     │░░░░░░░░░░░░░░░░░░░░░░│  screenshot.png · 1280 × 720        │  ← Image: size reserved
│     │░░░░░░░░░░░░░░░░░░░░░░│                                     │
│     └──────────────────────┘                                     │
│     ┌─────────────────────────────────────────┐                  │
│     │ [file] notes.pdf · 2.1 MB    [Download] │                  │  ← Other files: card
│     └─────────────────────────────────────────┘                  │
│ (M) Mika                                                   10:55 │
│     sure, looking now                             Sending…       │  ← Pending: dimmed
│     here's the link              (!) Not sent  [Retry] [Delete]  │  ← Failed: retry or delete
│     Message deleted by Bo                                        │  ← Moderators only
│                                                                  │
│                                               [↓ Jump to latest] │  ← When scrolled up
└──────────────────────────────────────────────────────────────────┘
```

States:

```text
┌─ Empty channel ──────────────────────────┐   ┌─ Loading history ────────────────────────┐
│                                          │   │ (A) ░░░░░░░░░  ░░░░                      │
│ # Welcome to #general                    │   │     ░░░░░░░░░░░░░░░░░░░░░░░░             │
│ This is the start of the channel.        │   │ (B) ░░░░░░  ░░░░                         │
│                                          │   │     ░░░░░░░░░░░░░░░░                     │
│ [Invite people]                          │   │                                          │
│   (shown only with Create invite)        │   │ (no shimmer when motion is reduced)      │
└──────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

Message "More" menu (also on right-click) and the link check for lookalike or IDN domains (12 §5.6):

```text
┌─ Message ────────────────────┐   ┌─ Open this link? ────────────────────────────────┐
│ Reply                  R     │   │ This link goes somewhere other than it shows.    │
│ Add reaction           ►     │   │                                                  │
│ Copy text                    │   │   Shown as   paypal.com                          │
│ Copy message link            │   │   Goes to    xn--pypal-4ve.com                   │
│ Mark unread                  │   │                                                  │
├──────────────────────────────┤   │   Only open it if you trust the sender.          │
│ Edit                   E     │   │                                                  │
│ Delete message               │   │                             [Cancel] [Open link] │
└──────────────────────────────┘   └──────────────────────────────────────────────────┘
```

- Messages from one author within 7 minutes group under one header (comfortable density). Compact density puts the name inline and hides avatars (style guide §6.2).
- Timestamps show local time; hover or focus shows the full date (`Intl.DateTimeFormat`).
- The action toolbar appears on hover **and** on keyboard focus. Own messages add Edit; Delete appears for own messages or with Manage messages, and always confirms.
- Reactions (R-017) show as a row of chips; the row is absent when the module is off.
- Scroll position stays put when older pages load or images arrive (reserved sizes). Reaching the bottom marks the channel read (12 §5.4).
- Reply references and search results jump with `around=<id>`; the target message is briefly highlighted (no motion under reduced motion).

Keyboard: the list is a feed. ↑/↓ or PageUp/PageDown move between messages once focus is inside; R replies, E edits your own, Shift+F10 opens the menu, Esc returns to the composer and marks the channel read.

## W-04 Composer

Status: Draft · Trace: 12 §5.5, R-014, R-015, R-021

```text
┌─ 1. Default ───────────────────────────────────────────────────┐
│ [+]  Message #general                           [Emoji] [Send] │
└────────────────────────────────────────────────────────────────┘
┌─ 2. Replying ──────────────────────────────────────────────────┐
│ Replying to Ann     [x] Notify Ann                         [×] │
├────────────────────────────────────────────────────────────────┤
│ [+]  Message #general                           [Emoji] [Send] │
└────────────────────────────────────────────────────────────────┘
┌─ 3. Editing ───────────────────────────────────────────────────┐
│ Editing message · Esc to cancel · Enter to save                │
├────────────────────────────────────────────────────────────────┤
│ it fixed the echo thing for me|                                │
└────────────────────────────────────────────────────────────────┘
┌─ 4. Uploading ─────────────────────────────────────────────────┐
│ ┌───────────────────────┐ ┌───────────────────────┐            │
│ │ ░░ photo.jpg          │ │ [file] notes.pdf      │            │
│ │ ▓▓▓▓▓▓▓░░░░ 62%   [×] │ │ Waiting…          [×] │            │
│ └───────────────────────┘ └───────────────────────┘            │
│ [+]  Add a message (optional)                   [Emoji] [Send] │
└────────────────────────────────────────────────────────────────┘
┌─ 5. Over quota ────────────────────────────────────────────────┐
│ [+]  Message #general                           [Emoji] [Send] │
├────────────────────────────────────────────────────────────────┤
│ (!) trip.mp4 is 300 MB, but only 120 MB of your upload space   │
│     is left.  [Manage storage]                                 │
└────────────────────────────────────────────────────────────────┘
```

```text
┌─ Mentions ───────────────────────────┐
│▌● (A) Ann                        ann │
│ ● (B) Bo                          bo │
│ ○ (L) Lee                        lee │
├──────────────────────────────────────┤
│ @Moderator                           │
│ @everyone         notifies 42 people │
└──────────────────────────────────────┘
┌─ 6. Mention autocomplete (popup above) ────────────────────────┐
│ [+]  hey @a|                                    [Emoji] [Send] │
└────────────────────────────────────────────────────────────────┘
┌─ 7. Slowmode ──────────────────────────────────────────────────┐
│ [+]  Message #general                    Slowmode 0:08  [Send] │
└────────────────────────────────────────────────────────────────┘
┌─ 8. Timed out ─────────────────────────────────────────────────┐
│ You're timed out until 14:30. You can read but not send.       │
└────────────────────────────────────────────────────────────────┘
┌─ 9. No permission ─────────────────────────────────────────────┐
│ You don't have permission to send messages in this channel.    │
└────────────────────────────────────────────────────────────────┘
┌─ 10. Reconnecting ─────────────────────────────────────────────┐
│ [+]  Message #general                           [Emoji] [Send] │
├────────────────────────────────────────────────────────────────┤
│ Messages you send now will go out when you're reconnected.     │
└────────────────────────────────────────────────────────────────┘
┌─ 11. Offline ──────────────────────────────────────────────────┐
│ You're offline. You can send again when Tin Can reconnects.    │
└────────────────────────────────────────────────────────────────┘
```

- Enter sends, Shift+Enter adds a line. Touch always shows the Send button; whether desktop shows it by default is an open item.
- The composer grows with its content up to half the window, then scrolls.
- Drafts persist per channel on this device (12 §5.5).
- Paste or drop files to attach; each shows progress and can be cancelled. Files over the size limit or the quota are refused before upload with the reason (R-021, `QUOTA_EXCEEDED`).
- Mention autocomplete: ↑/↓ choose, Enter or Tab inserts, Esc closes. `@everyone` appears only with Mention everyone and says how many people it notifies.
- When sending is not allowed, the input is replaced by a sentence that says why (12 §5.5, §7), never a silently disabled box.

## W-05 Member list and user card

Status: Draft · Trace: R-006, R-031, 11 §2.4 · Calls: U7, U12

```text
┌─ Members ────────────┐   ┌─ User card (popover) ────────────────────┐   ┌─ More ─────────────────────┐
│ Admin — 1            │   │ (A)  Ann                               ● │   │ Copy username              │
│  ● (M) Mika          │   │      ann · Online                        │   │ Change nickname            │
│ Moderator — 1        │   │      "fixing my mic, brb"                │   ├────────────────────────────┤
│  ● (B) Bo     ◄)     │   ├──────────────────────────────────────────┤   │ Time out…                  │
│ Online — 2           │   │ Roles   (•Moderator)                 [+] │   │ Kick…                      │
│▌ ● (A) Ann   LIVE    │   │ In voice: Lounge · sharing screen        │   │ Ban…                       │
│  ◦ (C) Cy            │   │         [Watch stream] [Join Lounge]     │   └────────────────────────────┘
│ Offline — 8          │   │ Member since 3 March 2026                │
│  ○ (D) Dee           │   ├──────────────────────────────────────────┤
│  ○ (E) Eli           │   │ [Mention]                       [More ▼] │
│  …                   │   └──────────────────────────────────────────┘
└──────────────────────┘
```

- Groups: roles marked "show separately" (in their role order), then Online, then Offline (U12). Inside a group, names sort alphabetically.
- Members in voice show `◄)`; members sharing show LIVE. Both are buttons with the same actions as in the channel list.
- Clicking a member (or Enter) opens the user card. Moderation items in More appear only when you outrank the member (11 §2.4) and each opens a confirm dialog with a reason field (logged in the audit log, 11 §3).
- There are no DMs in v1 (18 Q2), so the card offers Mention instead of Message.
- The list is virtualised for large servers; offline members load as you scroll.

## W-06 Voice panel and user panel

Status: Draft · Trace: R-032–R-037, 08 §4.4–4.5, 10 §5 · Calls: U1

Voice panel states:

```text
┌─ 1 Connecting ────────┐  ┌─ 2 Connected ─────────┐  ┌─ 3 Reconnecting ──────┐
│ ◄) Lounge             │  │ ◄) Lounge   ▪▪▪ 34 ms │  │ ◄) Lounge         ▪░░ │
│ Connecting…           │  │ Voice connected [E2E] │  │ Reconnecting…         │
│ [Cancel]              │  │ [Cam] [Share] [Leave] │  │ [Cam] [Share] [Leave] │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
┌─ 4 Poor connection ───┐  ┌─ 5 Sharing ───────────┐  ┌─ 6 Watching ──────────┐
│ ◄) Lounge  ▪░░ 310 ms │  │ ◄) Lounge   ▪▪▪ 34 ms │  │ ◄) Lounge   ▪▪▪ 34 ms │
│ (!) Poor connection   │  │ Sharing: Figma        │  │ Watching Ann          │
│ [Cam] [Share] [Leave] │  │ [Cam] [Stop] [Leave]  │  │ [Return to stream]    │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
┌─ 7 Replaced ──────────┐  ┌─ 8 Voice offline ─────┐  ┌─ 9 Can't encrypt ─────┐
│ ◄) Lounge             │  │ Voice is unavailable  │  │ This channel needs    │
│ You joined voice from │  │ right now. Text chat  │  │ encryption that this  │
│ another device.       │  │ still works.          │  │ browser lacks.        │
│ [Rejoin here]         │  │ [Try again]           │  │ [Learn more]          │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
```

User panel states and the status menu:

```text
┌─ Normal ──────────────┐  ┌─ Muted ───────────────┐  ┌─ Deafened ────────────┐
│ (M) Mika    [M][D][S] │  │ (M) Mika   [M/][D][S] │  │ (M) Mika  [M/][D/][S] │
│     ● Online          │  │     ● Online          │  │     ● Online          │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
┌─ Server-muted ────────┐  ┌─ Push to talk ────────┐  ┌─ Status menu ─────────┐
│ (M) Mika   [M!][D][S] │  │ (M) Mika    [M][D][S] │  │ ● Online              │
│   Muted by a moderator│  │     Hold F to talk    │  │ ◦ Idle                │
└───────────────────────┘  └───────────────────────┘  │ ■ Do not disturb      │
                                                      │   Mutes notifications │
                                                      │ ○ Invisible           │
                                                      │   Shown as offline    │
                                                      ├───────────────────────┤
                                                      │ Set a custom status…  │
                                                      └───────────────────────┘
```

Connection details (click the quality bars) and the participant menu (right-click a person in voice):

```text
┌─ Voice connection ───────────────────┐   ┌─ Ann (right-click) ──────────────────┐
│ Lounge · Friends of Tin              │   │ Volume  ──────●──────           100% │
│                                      │   │ [ ] Mute for me                      │
│ Quality                         Good │   │ Stream  ───●─────────            60% │
│ Ping                           34 ms │   │   (only while you watch Ann's stream)│
│ Route                   Direct (UDP) │   │ View profile                         │
│ Encryption                  On [E2E] │   ├──────────────────────────────────────┤
│                                      │   │ Server mute                          │
│ Encrypted so the media server can't  │   │ Move to                            ► │
│ read it. The server admin who manages│   │ Disconnect                           │
│ keys is still trusted.               │   └──────────────────────────────────────┘
│                                      │
│ [Test connection]  [Stats for nerds] │
└──────────────────────────────────────┘
```

- **Mute and deafen:** deafen also mutes; undeafening restores the earlier mute state (12 §6.3). The tooltip shows the shortcut.
- **Server-muted:** the mic toggle shows `[M!]`, is disabled, and the tooltip says "Muted by a moderator" (08 §4.3).
- **Push to talk:** the user panel shows the key; while it is held, the status line says "Talking" and your speaking ring shows.
- **Reconnecting** keeps the controls usable; nothing in the call is torn down until the departure timeout (08 §4.4).
- **Replaced (7):** joining from another device ends the session here with a clear reason (08 §4.5).
- **Per-user volume** goes from 0 to 200%; above 100% the menu warns about echo without headphones (09 §7, K-17). Volume and "Mute for me" persist on this device per user.
- **Stream volume** in the participant menu is the same control as on the stream tile (R-047); it shows only while you watch that person's stream.
- The E2EE text in the connection popover is the wording from 10 §2; there is no "verified" badge (10 §5).

## W-07 Banners, toasts and blocking screens

Status: Draft · Trace: 12 §5.2, §11, 13 §8, 08 §11

Banners (one at a time; offline beats reconnecting beats update):

```text
┌─ Reconnecting (status) ────────────────────────────────────────────────────┐
│ (…) Reconnecting. Anything you send will go out once you're back.          │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Offline (alert) ──────────────────────────────────────────────────────────┐
│ (!) You're offline. Tin Can will reconnect on its own.                     │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Web: new version ─────────────────────────────────────────────────────────┐
│ A new version of Tin Can is available.                           [Refresh] │
└────────────────────────────────────────────────────────────────────────────┘
┌─ Desktop: update while in a call ──────────────────────────────────────────┐
│ Update ready. It installs when you leave voice.      [Restart now] [Later] │
└────────────────────────────────────────────────────────────────────────────┘
```

Toasts (bottom end corner, polite, F8 to reach):

```text
┌─ Toast ────────────────────────────────────┐   ┌─ Toast ────────────────────────────────────┐
│ Headset unplugged. Now using Speakers      │   │ Switched to lighter noise suppression to   │
│ (Realtek).                                 │   │ keep your audio smooth.                    │
│                               [Change] [×] │   │                              [Details] [×] │
└────────────────────────────────────────────┘   └────────────────────────────────────────────┘
```

Blocking screens and dialogs:

```text
┌─ Version too old (full screen) ────────────┐   ┌─ Microphone blocked ─────────────────────────────┐
│                                            │   │ Tin Can can't use your microphone.               │
│     This server needs a newer Tin Can      │   │                                                  │
│                                            │   │ Allow microphone access for Tin Can in           │
│    You have 1.2.0. Friends of Tin needs    │   │ Settings > Privacy > Microphone, then try again. │
│               1.4 or later.                │   │                                                  │
│                                            │   │ [Open settings]           [Listen only] [Cancel] │
│                [Update now]                │   └──────────────────────────────────────────────────┘
│              (web: [Reload])               │
│                                            │
└────────────────────────────────────────────┘
```

- Banners use `role="status"`; offline uses `role="alert"`. Neither steals focus.
- Desktop never restarts mid-call for an update (13 §8); the banner says when it will install.
- Version too old (`CLIENT_TOO_OLD`) replaces the whole app until updated (12 §11).
- Microphone blocked offers "Listen only", so a person can still join and hear (R-034).
- Errors that need action (kicked, banned, voice failed to join) use a dialog or the voice panel, never a toast that disappears.

## Open items

- Send button visibility on desktop (always shown vs touch only).
- Message grouping window (7 minutes proposed).
- Whether the participant menu also offers "Watch stream" for people who share.
