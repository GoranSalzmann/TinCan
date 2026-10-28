# Tin Can UI design (M0)

> Status: **DRAFT.** Design calls U1–U16 approved on 2026-10-28; screens and style guide awaiting
> approval (18 T23, K-27). Drafted by Claude in M0; UI code starts only after you approve
> (17 §3 M0, §5).

Low-fi wireframes for the main screens and a token and style guide. Everything is Markdown
with ASCII frames so it diffs in git (00 conventions).

| File | Contents |
|---|---|
| [style-guide.md](style-guide.md) | Themes, colour tokens with checked contrast, type, spacing, radius, elevation, motion, icons, focus and keyboard, writing and i18n, RTL, component inventory mapped to Radix |
| [wireframes-main.md](wireframes-main.md) | W-01 to W-07: main layout, channel list, messages, composer, members, voice and user panels, banners |
| [wireframes-voice-video.md](wireframes-voice-video.md) | W-10 to W-17: call view, stream focus and grid, sharing bar and viewers, watch opt-in, desktop source picker, web share, pop-out |
| [wireframes-settings.md](wireframes-settings.md) | W-20 to W-26: settings shell, Voice & audio, Keybinds, Storage, Devices & sessions, connection test, Appearance |
| [wireframes-onboarding.md](wireframes-onboarding.md) | W-30 to W-34: first-run setup, desktop first launch, invite page, join and log in, saved servers |
| [wireframes-admin.md](wireframes-admin.md) | W-40 to W-43: role editor, channel permissions with effective result, preview as member, invites |
| [wireframes-mobile.md](wireframes-mobile.md) | W-50 to W-55: breakpoints, drawer, sheets, bottom bar, mobile stream view |
| [tools/check_contrast.py](tools/check_contrast.py) | Recomputes every contrast pairing in the style guide; run after changing a colour |

## How to review

- **Low-fi means:** the frames settle layout, hierarchy, content, states and behaviour. Colours, sizes and icons come from the style guide, not from the frames.
- **Per screen:** set the Status column in the [review table](#review-table) to Approved or Changes, with a note; or comment on lines in the commit or PR. Every screen also lists what it traces to (R-xxx, doc sections) so you can check coverage.
- **Design calls:** where I had to choose, or where a frame changes or interprets another doc, the call is listed as U1–U16 [below](#calls-to-approve). All sixteen were approved as drafted on 2026-10-28; changing one later changes the frames named there.
- **Copy:** text in frames is draft English. Strings get keys and ICU messages at implementation (style guide §12).
- **Direction:** frames are left-to-right at desktop width unless stated; RTL mirrors as in [W-01](wireframes-main.md#w-01-main-layout).

## Legend

| Glyph | Meaning |
|---|---|
| `┌─┐ │ └─┘` | Frame, panel or control outline |
| `[Label]` | Button; `[×]` closes |
| `[ Value ▼ ]` | Select |
| `[ text ]` | Text field |
| `[x]` `[ ]` | Checkbox on, off |
| `(•)` `( )` | Radio or segmented choice, selected and not |
| `[ on ]` `[ off ]` | Switch |
| `──●──` | Slider |
| `▓▓▓░░░` | Meter or progress bar |
| `░░░░` | Image, video or screen content |
| `▒▒▒▒` | Scrim behind a drawer or sheet, or the on-screen keyboard |
| `▌` at the start of a row | Selected or current item |
| `•` at the start of a row | Unread pill |
| `┃` at the start of a row | Mention highlight bar |
| `#` `◄)` | Text channel, voice channel |
| `(A)` | Avatar showing an initial |
| `◙` | Avatar with the speaking ring |
| `●` `◦` `■` `○` | Presence: online, idle, do not disturb, offline (distinct shapes in the UI, style guide §4) |
| `(m)` `(d)` `(M)` | Self-muted, deafened, server-muted |
| `[M]` `[M/]` `[M!]` | Mic toggle: on, muted, muted by a moderator |
| `[D]` `[D/]` | Deafen toggle: hearing, deafened |
| `[S]` | Settings |
| `LIVE` `CAM` | Live badges: screen share, camera |
| `[E2E]` | End-to-end encrypted (a lock icon in the UI) |
| `▪▪▪` | Connection quality bars |
| `(!)` | Warning or error icon |
| `(eye)` | "You're watching" indicator |
| `[ok]` `[!!]` `[..]` `[--]` | Check passed, failed, running, skipped |
| `[2]` | Mention count badge |
| `≡` | Drag handle |
| `← note` | Annotation outside the frame; not part of the UI |

## Calls to approve

| ID | Call | Why | Affects | Decision |
|---|---|---|---|---|
| U1 | Mute and deafen live in the **user panel** (always visible), not the voice panel | They must work before you join; 12 §4 lists them in the voice panel | 12 §4; W-01, W-06 | Approved |
| U2 | Joining a voice channel **doesn't replace** the text channel you're reading; the call view opens on demand | People drop into voice mid-conversation | W-01, W-10 | Approved |
| U3 | The stream view takes the main column, and **leaving it stops the download** unless popped out; no chat-beside-stream split in v1 | Matches "unsubscribe when not displayed" (12 §6.1, 08 §4.2); split view is extra layout work | W-11, W-17 | Approved |
| U4 | The focus ring has its own colour, not the accent | Focus must never look like selection | Style guide §3, §11 | Approved |
| U5 | The **web client has no instance rail**; the desktop app shows it with saved servers and "+" | One instance on the web; the rail exists for the switcher (12 §4, 13 §6) | W-01, W-34, W-50 | Approved |
| U6 | The accent comes from **7 checked presets**, not a free colour picker, in v1 | Every option is AA in light and dark | 12 §13; W-26 | Approved |
| U7 | Role colours never colour text; they show as a dot and pill border | User-chosen colours can't be guaranteed readable | Style guide §3; W-05, W-40 | Approved |
| U8 | The member list docks only at ≥ 1280 px; narrower, it is an overlay | Messages keep a readable width | 12 §14; W-55 | Approved |
| U9 | Settings is a full-screen layer with mute, deafen and leave in its navigation | Voice keeps running (12 §6.3) and settings covers the voice panel | W-20 | Approved |
| U10 | Icons: Lucide, bundled | ISC licence, broad set, tree-shakable, no CDN | Style guide §10 | Approved |
| U11 | No bundled text font in v1 | `system-ui` covers every script with nothing to download (12 §13 allows one) | Style guide §5 | Approved |
| U12 | Member list groups: roles marked "show separately", then Online, then Offline. Adds a `role.hoist` boolean to 06 | Useful groups without colouring names | 06 `role` (added); W-05, W-40 | Approved |
| U13 | Selecting a voice channel joins at once, with no confirm; joining another leaves the current one | Common chat-app convention; 12 §6.3 | W-02 | Approved |
| U14 | Saved servers you aren't connected to show **no unread badges** | One connection at a time (13 §6); stale counts would mislead | W-34 | Approved |
| U15 | The "can see you watching" notice is a one-time popover, not a blocking dialog | 08 §5.6 asks for a one-time notice; a dialog interrupts the stream | W-14 | Approved |
| U16 | Storage lists your largest uploads with delete. Adds an own-attachments list and delete to 07 | People need a way to free space when they hit the quota | 07 §3.7 (added); W-23 | Approved |

## Review table

| ID | Screen | File | Status | Notes |
|---|---|---|---|---|
| — | Style guide (tokens, type, motion, components) | [style-guide.md](style-guide.md) | Draft | |
| W-01 | Main layout | [main](wireframes-main.md#w-01-main-layout) | Draft | |
| W-02 | Channel list | [main](wireframes-main.md#w-02-channel-list) | Draft | |
| W-03 | Message list | [main](wireframes-main.md#w-03-message-list) | Draft | |
| W-04 | Composer | [main](wireframes-main.md#w-04-composer) | Draft | |
| W-05 | Member list and user card | [main](wireframes-main.md#w-05-member-list-and-user-card) | Draft | |
| W-06 | Voice panel and user panel | [main](wireframes-main.md#w-06-voice-panel-and-user-panel) | Draft | |
| W-07 | Banners, toasts and blocking screens | [main](wireframes-main.md#w-07-banners-toasts-and-blocking-screens) | Draft | |
| W-10 | Call view | [voice-video](wireframes-voice-video.md#w-10-call-view) | Draft | |
| W-11 | Stream view: focus | [voice-video](wireframes-voice-video.md#w-11-stream-view-focus) | Draft | |
| W-12 | Stream view: grid | [voice-video](wireframes-voice-video.md#w-12-stream-view-grid) | Draft | |
| W-13 | Sharing bar and viewer list | [voice-video](wireframes-voice-video.md#w-13-sharing-bar-and-viewer-list) | Draft | |
| W-14 | Watch opt-in | [voice-video](wireframes-voice-video.md#w-14-watch-opt-in) | Draft | |
| W-15 | Desktop source picker | [voice-video](wireframes-voice-video.md#w-15-desktop-source-picker) | Draft | |
| W-16 | Web screen share | [voice-video](wireframes-voice-video.md#w-16-web-screen-share) | Draft | |
| W-17 | Pop-out and picture-in-picture | [voice-video](wireframes-voice-video.md#w-17-pop-out-and-picture-in-picture) | Draft | |
| W-20 | Settings shell | [settings](wireframes-settings.md#w-20-settings-shell) | Draft | |
| W-21 | Voice & audio | [settings](wireframes-settings.md#w-21-voice--audio) | Draft | |
| W-22 | Keybinds | [settings](wireframes-settings.md#w-22-keybinds) | Draft | |
| W-23 | Storage | [settings](wireframes-settings.md#w-23-storage) | Draft | |
| W-24 | Devices & sessions | [settings](wireframes-settings.md#w-24-devices--sessions) | Draft | |
| W-25 | Connection test | [settings](wireframes-settings.md#w-25-connection-test) | Draft | |
| W-26 | Appearance | [settings](wireframes-settings.md#w-26-appearance) | Draft | |
| W-30 | First-run setup | [onboarding](wireframes-onboarding.md#w-30-first-run-setup) | Draft | |
| W-31 | Desktop first launch and add server | [onboarding](wireframes-onboarding.md#w-31-desktop-first-launch-and-add-server) | Draft | |
| W-32 | Invite page (web) | [onboarding](wireframes-onboarding.md#w-32-invite-page-web) | Draft | |
| W-33 | Join, log in and reset code | [onboarding](wireframes-onboarding.md#w-33-join-log-in-and-reset-code) | Draft | |
| W-34 | Saved servers switcher | [onboarding](wireframes-onboarding.md#w-34-saved-servers-switcher) | Draft | |
| W-40 | Role editor | [admin](wireframes-admin.md#w-40-role-editor) | Draft | |
| W-41 | Channel permissions | [admin](wireframes-admin.md#w-41-channel-permissions) | Draft | |
| W-42 | Preview as member | [admin](wireframes-admin.md#w-42-preview-as-member) | Draft | |
| W-43 | Invites | [admin](wireframes-admin.md#w-43-invites) | Draft | |
| W-50 | Compact: channel | [mobile](wireframes-mobile.md#w-50-compact-channel) | Draft | |
| W-51 | Compact: channel drawer | [mobile](wireframes-mobile.md#w-51-compact-channel-drawer) | Draft | |
| W-52 | Compact: member sheet | [mobile](wireframes-mobile.md#w-52-compact-member-sheet) | Draft | |
| W-53 | Compact: voice sheet | [mobile](wireframes-mobile.md#w-53-compact-voice-sheet) | Draft | |
| W-54 | Compact: stream view | [mobile](wireframes-mobile.md#w-54-compact-stream-view) | Draft | |
| W-55 | Medium: member overlay | [mobile](wireframes-mobile.md#w-55-medium-member-overlay) | Draft | |

## Not drawn yet

These reuse the patterns above; say which you want drawn before M2:
search results, emoji picker, quick switcher (Ctrl/Cmd+K), shortcut list (Ctrl/Cmd+/),
Profile, Notifications, Video, Streaming, Language, Advanced and About settings, Server
overview, Channels, Members, Audit log and Modules & status admin pages, and the moderation
dialogs (kick, ban, timeout). App icon, logo and brand basics are a separate M0 item (17 §3).

## After approval

1. Mark approved screens here; fold requested changes back into the frames.
2. Done 2026-10-28: the doc changes the approved calls need, in 12 §2, §4, §13 and §14 (U1, U6, U8, U10, U11), 06 `role.hoist` (U12), 07 §3.7 own attachments (U16) and the 17 §7 backlog (U3).
3. M1 turns the token tables into `packages/ui` tokens, generated CSS and Tailwind theme, and ports `tools/check_contrast.py` to a test (16).
4. Close 18 T23 and lower K-27.

## Open items

- Screen-by-screen approval in the review table.
- Each wireframe file and the style guide end with their own open items.
