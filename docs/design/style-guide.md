# Style guide and design tokens

> Status: **DRAFT, awaiting approval** (18 T23, K-27). Approve or mark up per section; the
> review table is in [README.md](README.md). Wireframes that use these tokens are listed there too.

This guide fixes the visual language before UI code starts: colour tokens for three themes,
type, spacing, radius, elevation, motion, icons, keyboard and focus rules, writing and
localisation rules, RTL rules, and the component inventory mapped to Radix primitives.
Everything here becomes CSS variables and Tailwind theme entries in M1 (12 §2, §13).

## 1. Principles

1. **Content first, chrome quiet.** Neutral surfaces, one accent colour, colour reserved for state (speaking, live, unread, error).
2. **State is never shown by colour alone.** Every coloured state also has a shape, icon, text or position (WCAG 1.4.1). See §4.
3. **Keyboard-first.** Every action is reachable and visible-focusable from the keyboard; pointer and touch are equals, not the default (N-011).
4. **Local only.** No fonts, icons, emoji or scripts from third-party CDNs at runtime (12 §2, 15). System fonts, bundled icons.
5. **Built for translation and RTL from day one.** Logical CSS properties, no fixed-width labels, no string concatenation (N-012).
6. **Calm motion.** Short, purposeful transitions; none at all when the user or OS asks for reduced motion.
7. **Restrained design system.** A small set of tokens and components (17 §5). New tokens need a reason.

## 2. Themes

| Theme | Selected by | Notes |
|---|---|---|
| Light | Appearance setting, or System when the OS is in light mode | Default for `prefers-color-scheme: light` |
| Dark | Appearance setting, or System when the OS is in dark mode | Default for `prefers-color-scheme: dark` |
| High contrast | Appearance setting, or System when `prefers-contrast: more` | Dark-based; text ≥ 7:1, every boundary drawn, no shadows; ignores the custom accent |
| Forced colours | Automatic when `forced-colors: active` (Windows contrast themes) | Tokens give way to system colours (`Canvas`, `CanvasText`, `Highlight`, `ButtonText`, `LinkText`); icons use `currentColor`; focus and selection use `Highlight` |

- The resolved theme is set as `data-theme="light|dark|hc"` on `<html>`. A `prefers-color-scheme` block in the generated CSS covers first paint before settings load, because the CSP forbids inline scripts (12 §15).
- Theme and accent are **synced** settings; text size, density and reduced motion are **device-local** (12 §8).
- The instance name and icon are Host-customisable (12 §13); they never change theme colours.

## 3. Colour tokens

Components use only these semantic tokens, never raw palette values (a lint rule bans raw
Tailwind palette classes such as `bg-gray-800` in `apps/web`). Values with eight hex digits
are translucent (`#RRGGBBAA`).

| Colour token | Light | Dark | High contrast | Use |
|---|---|---|---|---|
| `--color-bg-rail` | `#E2E5EA` | `#0E1014` | `#000000` | Instance rail (desktop) |
| `--color-bg-sidebar` | `#F1F3F6` | `#16191E` | `#000000` | Channel list, member list, settings navigation |
| `--color-bg` | `#FFFFFF` | `#1D2026` | `#000000` | Main column: messages, settings content |
| `--color-bg-elevated` | `#FFFFFF` | `#262A31` | `#000000` | Popovers, menus, dialogs, toasts (HC adds a 2 px border) |
| `--color-bg-input` | `#F3F4F7` | `#2A2E36` | `#000000` | Text fields, composer, selects |
| `--color-bg-hover` | `#E7EAEF` | `#2C3038` | `#1F1F1F` | Hovered row, ghost button hover |
| `--color-bg-selected` | `#DADFE6` | `#353A44` | `#2E2E2E` | Selected channel, active navigation item (HC adds a start-edge bar) |
| `--color-bg-mention` | `#FDF3DC` | `#3A3222` | `#2B2300` | Message that mentions you (with a `--color-warning` start bar) |
| `--color-bg-video` | `#0A0B0D` | `#000000` | `#000000` | Stream and camera tiles, letterboxing |
| `--color-bg-video-label` | `#000000B8` | `#000000B8` | `#000000E0` | Name and status chips over video |
| `--color-overlay` | `#0A0B0D99` | `#000000B3` | `#000000D9` | Scrim behind dialogs, drawers and sheets |
| `--color-text` | `#11161C` | `#ECEFF3` | `#FFFFFF` | Primary text and icons |
| `--color-text-muted` | `#4B5462` | `#A9B1BE` | `#D9D9D9` | Timestamps, secondary labels, read channels, offline members |
| `--color-text-disabled` | `#8C95A2` | `#6C7482` | `#9E9E9E` | Disabled labels (exempt from contrast minimums; always paired with a reason) |
| `--color-text-link` | `#0B6A62` | `#63DCCB` | `#8CD3FF` | Links in messages; always underlined |
| `--color-text-on-video` | `#FFFFFF` | `#FFFFFF` | `#FFFFFF` | Text on `--color-bg-video-label` |
| `--color-accent` | `#0F766E` | `#34C3B0` | `#5CC8FF` | Primary buttons, switch on-state, slider fill, selected radio |
| `--color-accent-hover` | `#0B5F58` | `#5ED6C5` | `#9ADEFF` | Hover and pressed accent fills |
| `--color-accent-text` | `#0B6A62` | `#63DCCB` | `#5CC8FF` | Accent-coloured text: active tab, link-style buttons |
| `--color-text-on-accent` | `#FFFFFF` | `#04211D` | `#000000` | Labels on accent fills |
| `--color-border` | `#DADFE6` | `#30353E` | `#8A8A8A` | Dividers and card outlines (decorative) |
| `--color-border-control` | `#7B8595` | `#7C8595` | `#FFFFFF` | Outlines of inputs, checkboxes, radios, switch and slider tracks |
| `--color-focus` | `#1F5FD1` | `#7EB0FF` | `#FFD60A` | Focus ring; deliberately not the accent, so focus never looks like selection |
| `--color-danger` | `#C4261C` | `#D02F25` | `#FF6B6B` | Destructive buttons, mention badges, muted-mic icons |
| `--color-text-on-danger` | `#FFFFFF` | `#FFFFFF` | `#000000` | Labels on danger fills |
| `--color-danger-text` | `#B42318` | `#FF8F85` | `#FF8F8F` | Error messages, destructive text buttons |
| `--color-danger-bg-subtle` | `#FDECEA` | `#3D1F1E` | `#330000` | Error banner background |
| `--color-warning` | `#B54708` | `#F6BE5C` | `#FFD60A` | Mention start bar, warning icons |
| `--color-warning-text` | `#8F3A06` | `#F6BE5C` | `#FFD60A` | Warning text |
| `--color-warning-bg-subtle` | `#FEF2DF` | `#3A2D15` | `#332B00` | Warning banner background |
| `--color-success-text` | `#067647` | `#52E0A0` | `#5CFF9D` | Success text ("Connected", test passed) |
| `--color-success-bg-subtle` | `#E5F5EC` | `#15301F` | `#00331A` | Success banner background |
| `--color-speaking` | `#0C8A4C` | `#3DDC84` | `#5CFF9D` | Speaking ring around avatars and tiles (2 px; HC 3 px) |
| `--color-live` | `#C4261C` | `#D02F25` | `#FF6B6B` | LIVE badge fill |
| `--color-text-on-live` | `#FFFFFF` | `#FFFFFF` | `#000000` | LIVE badge label |
| `--color-presence-online` | `#12854C` | `#3DDC84` | `#5CFF9D` | Online: filled circle |
| `--color-presence-idle` | `#A65A06` | `#F6BE5C` | `#FFD60A` | Idle: crescent |
| `--color-presence-dnd` | `#C4261C` | `#F2555A` | `#FF6B6B` | Do not disturb: circle with a bar |
| `--color-presence-offline` | `#737D8C` | `#808999` | `#BDBDBD` | Offline and invisible: hollow ring |

Role colours (06 `role.color`) are user-chosen, so they are **never used for text**. A role
shows its colour as a small dot beside the role name and in the role pill border; member
names stay `--color-text`.

### 3.1 Contrast pairings

WCAG 2.2 AA: 4.5:1 for text and 3:1 for UI component boundaries and meaningful graphics
(focus rings, control outlines, speaking rings, presence shapes, icons). Every pairing the UI
uses is listed here. A component that needs a pairing not listed adds it here first.

| Foreground | Background | Min | Rule |
|---|---|---|---|
| `--color-text` | `--color-bg` | 4.5 | Body text |
| `--color-text` | `--color-bg-sidebar` | 4.5 | Channel and member names |
| `--color-text` | `--color-bg-rail` | 4.5 | Rail initials when no icon |
| `--color-text` | `--color-bg-elevated` | 4.5 | Menus, dialogs |
| `--color-text` | `--color-bg-input` | 4.5 | Typed text |
| `--color-text` | `--color-bg-hover` | 4.5 | Hovered rows |
| `--color-text` | `--color-bg-selected` | 4.5 | Selected rows |
| `--color-text` | `--color-bg-mention` | 4.5 | Mention-highlighted messages |
| `--color-text` | `--color-danger-bg-subtle` | 4.5 | Error banner |
| `--color-text` | `--color-warning-bg-subtle` | 4.5 | Warning banner |
| `--color-text` | `--color-success-bg-subtle` | 4.5 | Success banner |
| `--color-text-muted` | `--color-bg` | 4.5 | Timestamps |
| `--color-text-muted` | `--color-bg-sidebar` | 4.5 | Read channels, offline members |
| `--color-text-muted` | `--color-bg-elevated` | 4.5 | Menu hints, descriptions |
| `--color-text-muted` | `--color-bg-input` | 4.5 | Placeholders |
| `--color-text-muted` | `--color-bg-hover` | 4.5 | Hovered read channel |
| `--color-text-muted` | `--color-bg-selected` | 4.5 | Selected row secondary text |
| `--color-text-muted` | `--color-bg-mention` | 4.5 | Timestamp on a mention |
| `--color-text-link` | `--color-bg` | 4.5 | Links |
| `--color-text-link` | `--color-bg-hover` | 4.5 | Links in a hovered message |
| `--color-text-link` | `--color-bg-mention` | 4.5 | Links in a mention |
| `--color-text-link` | `--color-bg-elevated` | 4.5 | Links in dialogs |
| `--color-accent-text` | `--color-bg` | 4.5 | Active tab label |
| `--color-accent-text` | `--color-bg-sidebar` | 4.5 | Accent text in sidebars |
| `--color-accent-text` | `--color-bg-elevated` | 4.5 | Link buttons in dialogs |
| `--color-accent-text` | `--color-bg-hover` | 4.5 | Hovered link button |
| `--color-accent-text` | `--color-bg-selected` | 4.5 | Accent text on a selected row |
| `--color-text-on-accent` | `--color-accent` | 4.5 | Primary button label |
| `--color-text-on-accent` | `--color-accent-hover` | 4.5 | Primary button hover |
| `--color-text-on-danger` | `--color-danger` | 4.5 | Destructive button, mention badge count |
| `--color-text-on-live` | `--color-live` | 4.5 | LIVE badge |
| `--color-danger-text` | `--color-bg` | 4.5 | Errors |
| `--color-danger-text` | `--color-bg-sidebar` | 4.5 | "Leave" in the voice panel |
| `--color-danger-text` | `--color-bg-elevated` | 4.5 | Destructive menu items |
| `--color-danger-text` | `--color-danger-bg-subtle` | 4.5 | Error banner title |
| `--color-warning-text` | `--color-bg` | 4.5 | Warnings |
| `--color-warning-text` | `--color-bg-elevated` | 4.5 | Warnings in dialogs |
| `--color-warning-text` | `--color-warning-bg-subtle` | 4.5 | Warning banner title |
| `--color-success-text` | `--color-bg` | 4.5 | Success text |
| `--color-success-text` | `--color-bg-sidebar` | 4.5 | "Voice connected" |
| `--color-success-text` | `--color-bg-elevated` | 4.5 | Success in dialogs |
| `--color-success-text` | `--color-success-bg-subtle` | 4.5 | Success banner title |
| `--color-text-on-video` | `--color-bg-video-label` | 4.5 | Names over video (checked over white and black video) |
| `--color-focus` | `--color-bg` | 3 | Focus ring |
| `--color-focus` | `--color-bg-sidebar` | 3 | Focus ring |
| `--color-focus` | `--color-bg-rail` | 3 | Focus ring |
| `--color-focus` | `--color-bg-elevated` | 3 | Focus ring |
| `--color-focus` | `--color-bg-input` | 3 | Focus ring |
| `--color-focus` | `--color-bg-selected` | 3 | Focus ring |
| `--color-focus` | `--color-bg-video` | 3 | Focus ring on tiles |
| `--color-border-control` | `--color-bg` | 3 | Control outline |
| `--color-border-control` | `--color-bg-sidebar` | 3 | Control outline |
| `--color-border-control` | `--color-bg-elevated` | 3 | Control outline |
| `--color-border-control` | `--color-bg-input` | 3 | Input outline against its own fill |
| `--color-accent` | `--color-bg` | 3 | Switch on, slider fill, selected radio |
| `--color-accent` | `--color-bg-sidebar` | 3 | Same, in sidebars |
| `--color-accent` | `--color-bg-elevated` | 3 | Same, in dialogs |
| `--color-speaking` | `--color-bg-sidebar` | 3 | Speaking ring in the channel list |
| `--color-speaking` | `--color-bg` | 3 | Speaking ring in the call view |
| `--color-speaking` | `--color-bg-video` | 3 | Speaking ring on tiles |
| `--color-presence-online` | `--color-bg-sidebar` | 3 | Presence shapes |
| `--color-presence-online` | `--color-bg-elevated` | 3 | Presence in popovers |
| `--color-presence-idle` | `--color-bg-sidebar` | 3 | Presence shapes |
| `--color-presence-idle` | `--color-bg-elevated` | 3 | Presence in popovers |
| `--color-presence-dnd` | `--color-bg-sidebar` | 3 | Presence shapes |
| `--color-presence-dnd` | `--color-bg-elevated` | 3 | Presence in popovers |
| `--color-presence-offline` | `--color-bg-sidebar` | 3 | Presence shapes |
| `--color-presence-offline` | `--color-bg-elevated` | 3 | Presence in popovers |
| `--color-danger` | `--color-bg-sidebar` | 3 | Muted-mic icon in the channel list |
| `--color-danger` | `--color-bg` | 3 | Muted-mic icon in the call view |
| `--color-warning` | `--color-bg-mention` | 3 | Mention start bar |

Computed results (generated by `python docs/design/tools/check_contrast.py --write`; do not
edit by hand). High contrast is checked against the same minimums but is designed to reach
7:1 for text.

<!-- contrast:begin -->
| Foreground | Background | Min | Light | Dark | High contrast |
|---|---|---|---|---|---|
| `--color-text` | `--color-bg` | 4.5 | 18.18 | 14.15 | 21.00 |
| `--color-text` | `--color-bg-sidebar` | 4.5 | 16.35 | 15.28 | 21.00 |
| `--color-text` | `--color-bg-rail` | 4.5 | 14.39 | 16.51 | 21.00 |
| `--color-text` | `--color-bg-elevated` | 4.5 | 18.18 | 12.49 | 21.00 |
| `--color-text` | `--color-bg-input` | 4.5 | 16.53 | 11.80 | 21.00 |
| `--color-text` | `--color-bg-hover` | 4.5 | 15.07 | 11.47 | 16.48 |
| `--color-text` | `--color-bg-selected` | 4.5 | 13.57 | 9.89 | 13.58 |
| `--color-text` | `--color-bg-mention` | 4.5 | 16.47 | 10.97 | 15.64 |
| `--color-text` | `--color-danger-bg-subtle` | 4.5 | 15.89 | 12.88 | 18.41 |
| `--color-text` | `--color-warning-bg-subtle` | 4.5 | 16.43 | 11.63 | 14.13 |
| `--color-text` | `--color-success-bg-subtle` | 4.5 | 16.10 | 12.35 | 14.11 |
| `--color-text-muted` | `--color-bg` | 4.5 | 7.65 | 7.55 | 14.88 |
| `--color-text-muted` | `--color-bg-sidebar` | 4.5 | 6.89 | 8.15 | 14.88 |
| `--color-text-muted` | `--color-bg-elevated` | 4.5 | 7.65 | 6.67 | 14.88 |
| `--color-text-muted` | `--color-bg-input` | 4.5 | 6.96 | 6.30 | 14.88 |
| `--color-text-muted` | `--color-bg-hover` | 4.5 | 6.35 | 6.12 | 11.68 |
| `--color-text-muted` | `--color-bg-selected` | 4.5 | 5.71 | 5.28 | 9.62 |
| `--color-text-muted` | `--color-bg-mention` | 4.5 | 6.94 | 5.86 | 11.08 |
| `--color-text-link` | `--color-bg` | 4.5 | 6.46 | 9.81 | 12.88 |
| `--color-text-link` | `--color-bg-hover` | 4.5 | 5.35 | 7.96 | 10.11 |
| `--color-text-link` | `--color-bg-mention` | 4.5 | 5.85 | 7.61 | 9.59 |
| `--color-text-link` | `--color-bg-elevated` | 4.5 | 6.46 | 8.66 | 12.88 |
| `--color-accent-text` | `--color-bg` | 4.5 | 6.46 | 9.81 | 11.16 |
| `--color-accent-text` | `--color-bg-sidebar` | 4.5 | 5.81 | 10.60 | 11.16 |
| `--color-accent-text` | `--color-bg-elevated` | 4.5 | 6.46 | 8.66 | 11.16 |
| `--color-accent-text` | `--color-bg-hover` | 4.5 | 5.35 | 7.96 | 8.76 |
| `--color-accent-text` | `--color-bg-selected` | 4.5 | 4.82 | 6.86 | 7.22 |
| `--color-text-on-accent` | `--color-accent` | 4.5 | 5.47 | 7.72 | 11.16 |
| `--color-text-on-accent` | `--color-accent-hover` | 4.5 | 7.52 | 9.59 | 14.27 |
| `--color-text-on-danger` | `--color-danger` | 4.5 | 5.77 | 5.10 | 7.57 |
| `--color-text-on-live` | `--color-live` | 4.5 | 5.77 | 5.10 | 7.57 |
| `--color-danger-text` | `--color-bg` | 4.5 | 6.57 | 7.40 | 9.58 |
| `--color-danger-text` | `--color-bg-sidebar` | 4.5 | 5.91 | 7.99 | 9.58 |
| `--color-danger-text` | `--color-bg-elevated` | 4.5 | 6.57 | 6.53 | 9.58 |
| `--color-danger-text` | `--color-danger-bg-subtle` | 4.5 | 5.75 | 6.74 | 8.40 |
| `--color-warning-text` | `--color-bg` | 4.5 | 7.57 | 9.67 | 14.88 |
| `--color-warning-text` | `--color-bg-elevated` | 4.5 | 7.57 | 8.53 | 14.88 |
| `--color-warning-text` | `--color-warning-bg-subtle` | 4.5 | 6.84 | 7.94 | 10.01 |
| `--color-success-text` | `--color-bg` | 4.5 | 5.69 | 9.74 | 16.25 |
| `--color-success-text` | `--color-bg-sidebar` | 4.5 | 5.12 | 10.51 | 16.25 |
| `--color-success-text` | `--color-bg-elevated` | 4.5 | 5.69 | 8.59 | 16.25 |
| `--color-success-text` | `--color-success-bg-subtle` | 4.5 | 5.04 | 8.50 | 10.91 |
| `--color-text-on-video` | `--color-bg-video-label` | 4.5 | 9.29 | 9.29 | 16.48 |
| `--color-focus` | `--color-bg` | 3 | 5.81 | 7.41 | 14.88 |
| `--color-focus` | `--color-bg-sidebar` | 3 | 5.22 | 8.00 | 14.88 |
| `--color-focus` | `--color-bg-rail` | 3 | 4.60 | 8.65 | 14.88 |
| `--color-focus` | `--color-bg-elevated` | 3 | 5.81 | 6.54 | 14.88 |
| `--color-focus` | `--color-bg-input` | 3 | 5.28 | 6.19 | 14.88 |
| `--color-focus` | `--color-bg-selected` | 3 | 4.34 | 5.19 | 9.62 |
| `--color-focus` | `--color-bg-video` | 3 | 3.39 | 9.54 | 14.88 |
| `--color-border-control` | `--color-bg` | 3 | 3.73 | 4.39 | 21.00 |
| `--color-border-control` | `--color-bg-sidebar` | 3 | 3.35 | 4.74 | 21.00 |
| `--color-border-control` | `--color-bg-elevated` | 3 | 3.73 | 3.87 | 21.00 |
| `--color-border-control` | `--color-bg-input` | 3 | 3.39 | 3.66 | 21.00 |
| `--color-accent` | `--color-bg` | 3 | 5.47 | 7.44 | 11.16 |
| `--color-accent` | `--color-bg-sidebar` | 3 | 4.92 | 8.04 | 11.16 |
| `--color-accent` | `--color-bg-elevated` | 3 | 5.47 | 6.57 | 11.16 |
| `--color-speaking` | `--color-bg-sidebar` | 3 | 3.97 | 9.87 | 16.25 |
| `--color-speaking` | `--color-bg` | 3 | 4.42 | 9.15 | 16.25 |
| `--color-speaking` | `--color-bg-video` | 3 | 4.46 | 11.77 | 16.25 |
| `--color-presence-online` | `--color-bg-sidebar` | 3 | 4.21 | 9.87 | 16.25 |
| `--color-presence-online` | `--color-bg-elevated` | 3 | 4.68 | 8.07 | 16.25 |
| `--color-presence-idle` | `--color-bg-sidebar` | 3 | 4.62 | 10.44 | 14.88 |
| `--color-presence-idle` | `--color-bg-elevated` | 3 | 5.14 | 8.53 | 14.88 |
| `--color-presence-dnd` | `--color-bg-sidebar` | 3 | 5.19 | 5.22 | 7.57 |
| `--color-presence-dnd` | `--color-bg-elevated` | 3 | 5.77 | 4.27 | 7.57 |
| `--color-presence-offline` | `--color-bg-sidebar` | 3 | 3.75 | 5.00 | 11.18 |
| `--color-presence-offline` | `--color-bg-elevated` | 3 | 4.17 | 4.09 | 11.18 |
| `--color-danger` | `--color-bg-sidebar` | 3 | 5.19 | 3.45 | 7.57 |
| `--color-danger` | `--color-bg` | 3 | 5.77 | 3.20 | 7.57 |
| `--color-warning` | `--color-bg-mention` | 3 | 4.92 | 7.50 | 11.07 |
<!-- contrast:end -->

### 3.2 Accent presets

The accent is customisable per user (12 §13) from a **curated set** rather than a free colour
picker (U6, approved), so every option is checked in advance. The high-contrast theme keeps its own accent.
Teal is the default and matches the token table above.

| Accent preset | Theme | `--color-accent` | `--color-accent-hover` | `--color-accent-text` | `--color-text-on-accent` |
|---|---|---|---|---|---|
| Teal | Light | `#0F766E` | `#0B5F58` | `#0B6A62` | `#FFFFFF` |
| Teal | Dark | `#34C3B0` | `#5ED6C5` | `#63DCCB` | `#04211D` |
| Blue | Light | `#2557D6` | `#1C45AD` | `#1F4FC4` | `#FFFFFF` |
| Blue | Dark | `#6C9BFF` | `#93B5FF` | `#8DB1FF` | `#06142E` |
| Violet | Light | `#6D3FD1` | `#5730A8` | `#6236C2` | `#FFFFFF` |
| Violet | Dark | `#A58BFF` | `#BDA9FF` | `#B9A5FF` | `#160B33` |
| Rose | Light | `#C0245C` | `#9C1C4A` | `#AE1F53` | `#FFFFFF` |
| Rose | Dark | `#FF7AA8` | `#FF9DBE` | `#FF94B9` | `#33081A` |
| Amber | Light | `#A34F00` | `#853F00` | `#8F4500` | `#FFFFFF` |
| Amber | Dark | `#F2B13D` | `#F6C467` | `#F6BE5C` | `#2B1A00` |
| Green | Light | `#13773F` | `#0E5F32` | `#0F6D39` | `#FFFFFF` |
| Green | Dark | `#45C97A` | `#6CD898` | `#62D690` | `#052211` |
| Graphite | Light | `#39414D` | `#262C35` | `#39414D` | `#FFFFFF` |
| Graphite | Dark | `#B8C0CC` | `#D0D6DE` | `#C3CAD4` | `#11161C` |

Each preset is checked against every accent pairing in §3.1 for its theme:

<!-- accents:begin -->
| Preset | Theme | Pairings | Lowest ratio | Lowest pairing |
|---|---|---|---|---|
| Teal | Light | 10 | 4.82 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Teal | Dark | 10 | 6.86 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Blue | Light | 10 | 5.27 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Blue | Dark | 10 | 5.36 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Violet | Light | 10 | 5.55 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Violet | Dark | 10 | 5.37 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Rose | Light | 10 | 5.02 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Rose | Dark | 10 | 5.54 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Amber | Light | 10 | 5.19 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Amber | Dark | 10 | 6.76 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Green | Light | 10 | 4.80 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Green | Dark | 10 | 6.27 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Graphite | Light | 10 | 7.70 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
| Graphite | Dark | 10 | 6.91 (min 4.5) | `--color-accent-text` on `--color-bg-selected` |
<!-- accents:end -->

## 4. State without colour

| State | Colour | Plus |
|---|---|---|
| Presence | `--color-presence-*` | Shape: filled circle (online), crescent (idle), circle with bar (do not disturb), hollow ring (offline/invisible); text in the user card and an accessible name ("Bo, idle") |
| Speaking | `--color-speaking` ring | Ring is 2 px with a 2 px gap, so it reads as an outline even in greyscale; optional screen-reader announcement is off by default (12 §12) |
| Self-muted / deafened | `--color-text-muted` icon | Mic-with-slash and headphones-with-slash icons; accessible name "muted", "deafened" |
| Server-muted | `--color-danger` icon | Filled mic-with-slash (distinct from the outline self-mute icon); tooltip "Muted by a moderator" |
| Unread channel | `--color-text` instead of muted | Weight 600 plus a start-edge pill |
| Mentions | `--color-danger` badge | Badge shows the number; accessible name "3 mentions" |
| Mentioned message | `--color-bg-mention` | 3 px `--color-warning` start bar |
| Live stream / camera | `--color-live` badge | The words LIVE / CAM in the badge |
| E2EE | none | Lock icon plus the text in the tooltip (10 §5) |
| Errors in forms | `--color-danger-text` | Error icon plus a text message linked with `aria-describedby` |
| Links in messages | `--color-text-link` | Always underlined |
| Selected row | `--color-bg-selected` | `aria-current`/`aria-selected`; HC adds a start-edge bar |
| Permission overrides | Deny red, Allow green in the segmented control | Each segment carries an icon (×, /, ✓) and a text label |

## 5. Typography

### 5.1 Font stacks (system only, nothing downloaded)

```css
--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell,
             "Helvetica Neue", Arial, sans-serif,
             "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji";
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Consolas,
             "Liberation Mono", "DejaVu Sans Mono", Menlo, monospace;
```

- `system-ui` picks the right face per script and locale (CJK, Arabic, Hebrew, Cyrillic), which a single bundled Latin font cannot.
- Emoji render with the OS emoji font. Emoji picker data is bundled (12 §2); no emoji images are fetched.
- No bundled text font in v1 (U11, approved).

### 5.2 Type scale

All sizes in `rem`, so the Appearance text-size setting (root size 12–20 px, default 16 px)
scales the whole UI. Line heights are on a 2 px grid.

| Token | Size | Line height | Weight | Use |
|---|---|---|---|---|
| `--text-xs` | 0.75rem (12 px) | 1rem (16 px) | 500 | Timestamps, badges, hints, category labels |
| `--text-sm` | 0.8125rem (13 px) | 1.125rem (18 px) | 400 / 500 | Channel list, member list, menus, tooltips, form labels |
| `--text-base` | 0.9375rem (15 px) | 1.375rem (22 px) | 400 | Messages, inputs, buttons, settings body |
| `--text-lg` | 1.0625rem (17 px) | 1.5rem (24 px) | 600 | Channel header name, section headings |
| `--text-xl` | 1.25rem (20 px) | 1.75rem (28 px) | 600 | Dialog titles, settings page titles |
| `--text-2xl` | 1.5rem (24 px) | 2rem (32 px) | 700 | Onboarding and empty-state headings |
| `--text-code` | 0.875rem (14 px), mono | 1.375rem (22 px) | 400 | Inline code and code blocks |

Rules:
- Weights in use: 400, 500, 600, 700. Synthetic bold is avoided by sticking to these.
- Category labels ("Text channels") use `--text-xs`, weight 600, muted, letter-spacing 0.02em and **no uppercase transform** (scripts without case; screen readers spelling words out).
- `font-variant-numeric: tabular-nums` for timers, meters, counts, file sizes and latency.
- Text containers never have a fixed height; tall scripts (Thai, Devanagari) must not clip.
- Description text in settings and dialogs is capped at 65ch.

## 6. Spacing, sizing and layout

Spacing uses Tailwind's default 0.25rem scale. Allowed steps: 0, 0.5, 1, 1.5, 2, 3, 4, 5, 6,
8, 10, 12, 16 (that is 0–64 px). No arbitrary values in components.

| Layout token | Value | Notes |
|---|---|---|
| `--size-rail` | 4.5rem (72 px) | Desktop only (U5) |
| `--size-sidebar` | 15rem (240 px) | Channel list; user-resizable 12.5–22.5rem |
| `--size-members` | 15rem (240 px) | Member list |
| `--size-header` | 3rem (48 px) | Channel header, settings header |
| `--size-user-panel` | 3.25rem (52 px) | Bottom of the channel list |
| `--size-avatar-message` | 2.5rem (40 px) | Message author avatar |
| `--size-avatar-list` | 2rem (32 px) | Member list; 1.5rem (24 px) for voice participants in the channel list |
| `--size-target` | 1.5rem (24 px) fine pointer · 2.75rem (44 px) coarse pointer | Minimum hit area (WCAG 2.5.8, and 44 px on touch) |
| `--size-composer-min` | 2.75rem (44 px) | Composer grows to 50% of the viewport height, then scrolls |
| `--size-media-max` | 25rem × 20rem | Inline image preview box; the known width/height reserve space (12 §5.6) |
| `--size-dialog-sm / md / lg` | 27.5rem / 36rem / 52rem | Confirm dialogs / forms / source picker |
| `--size-content-max` | 46rem | Settings content column |

### 6.1 Breakpoints

| Name | Min width | Layout (details in [wireframes-mobile.md](wireframes-mobile.md)) |
|---|---|---|
| compact | 0 | One column. Channel list in a start-edge drawer, member list in a bottom sheet, voice panel as a bottom bar |
| medium | 768 px (`md`) | Channel list docked; member list opens as an overlay panel from the end edge |
| wide | 1280 px (`xl`) | Channel list and member list docked (member list can be hidden) |

Breakpoints are by available width, not device. `pointer: coarse` independently raises hit
targets to 44 px.

### 6.2 Density

| | Comfortable (default) | Compact |
|---|---|---|
| Message group spacing | `space-4` (16 px) | `space-1` (4 px) |
| Avatars in messages | Shown on the first message of a group | Hidden; name inline before the text |
| Channel row height | 2rem (32 px) | 1.75rem (28 px), never below the 24 px target |

## 7. Radius

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | 4px | Badges, checkboxes, keyboard chips |
| `--radius-md` | 6px | Buttons, inputs, menu items, channel rows |
| `--radius-lg` | 8px | Cards, popovers, menus, filmstrip tiles |
| `--radius-xl` | 12px | Dialogs, sheets (top corners only on compact), stream tiles, instance icons |
| `--radius-full` | 9999px | Avatars, presence, pills, switch |

Instance icons keep one shape (no morph-on-hover animation).

## 8. Elevation and stacking

Light uses shadows; dark uses a lighter surface plus a 1 px `--color-border`; high contrast
uses borders only.

| Level | Use | Light | Dark | High contrast |
|---|---|---|---|---|
| 0 | Page surfaces | none | none | none |
| 1 | Composer, cards, hovered tiles | `0 1px 2px #1018280F` | 1 px border | 1 px `--color-border` |
| 2 | Tooltips, popovers, menus | `0 4px 12px #1018281F, 0 1px 3px #10182814` | `0 4px 16px #00000073` + 1 px border | 2 px `--color-text` border |
| 3 | Dialogs, drawers, sheets, toasts | `0 16px 40px #1018282E` | `0 16px 48px #00000099` + 1 px border | 2 px `--color-text` border |

| Z-index token | Value | Use |
|---|---|---|
| `--z-sticky` | 10 | Sticky headers, date separators |
| `--z-banner` | 20 | Connection and update banners |
| `--z-overlay` | 40 | Scrims |
| `--z-modal` | 50 | Dialogs, drawers, sheets |
| `--z-popover` | 60 | Popovers and menus (above modals, so menus inside dialogs work) |
| `--z-toast` | 70 | Toasts |
| `--z-tooltip` | 80 | Tooltips |

## 9. Motion

| Token | Value | Use |
|---|---|---|
| `--duration-fast` | 100ms | Hover, press, toggle, speaking ring fade |
| `--duration-base` | 160ms | Tooltips, popovers, menus |
| `--duration-slow` | 240ms | Dialogs, drawers, sheets |
| `--ease-enter` | `cubic-bezier(0, 0, 0.2, 1)` | Things appearing |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Things leaving (exit uses ~75% of the enter duration) |
| `--ease-move` | `cubic-bezier(0.2, 0, 0, 1)` | Position changes |

Rules:
- Animate opacity and transform only. Never animate layout (width, height, top) in lists.
- The message list never animates new messages in; it only keeps scroll position stable.
- Speaking ring: on when speech starts, held for 250 ms after it stops (avoids flicker; the VAD itself holds 200 ms, 09 §4), fades over `--duration-fast`. No pulsing.
- Tooltips open after 500 ms, 0 ms when moving between tooltipped controls.
- **Reduced motion** (`prefers-reduced-motion: reduce`, or Appearance → Reduce motion): movement durations become 0; opacity fades stay at ≤ 100 ms; no smooth scrolling ("Jump to latest" jumps); no skeleton shimmer; animated images and avatars play only on hover or focus.
- Nothing flashes more than three times a second (WCAG 2.3.1), including the "reconnecting" indicator.

## 10. Icons

- **Lucide** (U10, approved; ISC licence, compatible with AGPL distribution, F2 licence scan), bundled as tree-shaken React components. No icon fonts, no CDN.
- Sizes: 16 px (inline, badges), 20 px (default: toolbars, rows), 24 px (call controls, mobile). Stroke 1.75 px; colour `currentColor`.
- Icon-only buttons always have an accessible name and a tooltip that also shows the shortcut.
- Mute, deafen, camera and share icons change **shape** between states (mic ↔ mic-off), not only colour.
- **Mirror in RTL:** arrows, back/forward, reply, send, chevrons for expand/collapse, pop-out, "jump to" arrows that point sideways, list and indent icons. **Do not mirror:** mic, headphones, camera, screen, media playback controls, clocks, checkmarks, search, brand marks.

## 11. Focus and keyboard

- Focus ring: 2 px solid `--color-focus`, 2 px offset (HC: 3 px), on `:focus-visible`. Never removed; never clipped by `overflow: hidden` (use `outline-offset` inside scroll containers).
- Landmarks, in **F6 / Shift+F6** order: instance rail → channel list → message list → composer → member list → voice panel. A skip link "Skip to messages" is first in tab order.
- Lists use roving tabindex: one tab stop per list, arrow keys inside (channel tree, message feed, member list, toolbars).
- Every context-menu action also exists in a visible "More" button menu, and Shift+F10 / the Menu key opens the context menu on the focused item.
- Esc closes the innermost layer (menu → popover → dialog → settings). Focus returns to the control that opened it.
- Drag and drop always has a keyboard or menu alternative (reorder channels, roles and instances via "Move up / Move down").

Default in-app shortcuts (all rebindable in Keybinds, [W-22](wireframes-settings.md#w-22-keybinds)):

| Action | Windows / Linux | macOS |
|---|---|---|
| Quick switcher (12 open item) | Ctrl+K | ⌘K |
| Shortcut list | Ctrl+/ | ⌘/ |
| Next / previous region | F6 / Shift+F6 | F6 / Shift+F6 |
| Previous / next channel | Alt+↑ / Alt+↓ | ⌥↑ / ⌥↓ |
| Previous / next unread channel | Alt+Shift+↑ / Alt+Shift+↓ | ⌥⇧↑ / ⌥⇧↓ |
| Search | Ctrl+F | ⌘F |
| Mark channel read | Esc (message list or empty composer) | Esc |
| Edit last message | ↑ in an empty composer | ↑ |
| Reply to focused message | R | R |
| Toggle mute / deafen | Ctrl+Shift+M / Ctrl+Shift+D | ⌘⇧M / ⌘⇧D |
| Push to talk | unbound until the user picks a key | unbound |
| Jump to toasts | F8 | F8 |

Browsers reserve some combinations; the web defaults are checked per browser in M1 and
changed where a page cannot intercept them (open item).

## 12. Writing and localisation

- **No string in code.** Every string has a key `module.area.name`, e.g. `voice.panel.leave`, `voice.sharing.viewers`. English is the source locale (N-012).
- **ICU MessageFormat** for plurals, selects and placeholders. Whole sentences only, never concatenated fragments:
  `voice.sharing.viewers = {count, plural, =0 {No one is watching} one {# person is watching} other {# people are watching}}`
- **Lists, dates, numbers, sizes** through `Intl`: `Intl.ListFormat` for viewer and typing lists ("Ann, Bo and Cy are typing"), `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` for timestamps, `Intl.NumberFormat` with units for file sizes, bitrates and latency.
- **Expansion:** assume +40% for labels (up to +100% for one-word labels). Buttons hug their text; no fixed widths; toolbars collapse labels into icon + tooltip before truncating a verb.
- **Truncation** only for user content (names, channel names, window titles): one line, ellipsis, full text in the tooltip and accessible name.
- **Bidi isolation:** user-generated text (names, channel names, status, window titles) is wrapped in `<bdi>` or `dir="auto"`, so an RTL name cannot reorder the surrounding UI text (also a spoofing defence, 15).
- **Pseudo-locales in dev builds:** `en-XA` (accented, 40% longer) and `ar-XB` (RTL) to catch hard-coded strings, clipping and mirroring bugs; used in visual tests (16).
- **Voice:** plain, short, friendly; sentence case; no blame. Errors say what happened and what to do next ("Your network blocks the fast path. Tin Can is using a slower one, so expect a little delay."). Technical detail goes under "Details" or "Stats for nerds".
- Shortcut labels render per OS (Ctrl vs ⌘) and per keyboard layout where the platform reports it.

## 13. Right-to-left

- `dir` on `<html>` comes from the locale; Radix gets it through `DirectionProvider` (menus, sliders, roving focus, arrow keys).
- **Logical properties only.** Tailwind `ms-/me-/ps-/pe-/start-/end-/text-start/text-end/border-s/border-e/rounded-s/rounded-e`. A lint rule bans the physical forms (`ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `rounded-l`, `rounded-r`, `border-l`, `border-r`) in `apps/web`.
- The whole layout mirrors: rail and channel list at the inline start (right in RTL), member list at the inline end ([W-01](wireframes-main.md#w-01-main-layout)).
- Sliders, meters and progress bars fill from the inline start. Tree expand/collapse arrows follow the inline direction.
- Video, screen shares and thumbnails are **never** mirrored. The local camera self-view is mirrored by default as a separate user setting, unrelated to RTL.
- Icons mirror per §10.

## 14. Assets and privacy

- Avatars, instance icons, attachments and thumbnails load only from the instance origin (12 §2, 13 §3, 18 T31).
- Images reserve their known width and height; no layout shift (12 §5.6).
- Animated images respect §9 reduced motion.
- No analytics, no web fonts, no remote images in link previews unless the server proxied them (R-019).

## 15. Component inventory

Built in `apps/web/src/ui/` (12 §3) on Radix Primitives plus Tailwind. Radix Themes is not used.

| Component | Built on (Radix) | Used in | Notes |
|---|---|---|---|
| Button | `Slot` (`asChild`) | Everywhere | Variants primary, secondary, ghost, danger, link; sizes sm 28 px, md 36 px, lg 44 px; loading state keeps width |
| Icon button | `Slot` + `Tooltip` | Toolbars, headers | Requires `aria-label`; tooltip shows the shortcut |
| Toggle button | `Toggle` | Mute, deafen, camera, share, watch | `aria-pressed`; icon changes shape per state |
| Toolbar | `Toolbar` | Voice panel, call controls, sharing bar, stream controls, message actions, composer actions | One tab stop, arrow keys inside |
| Tooltip | `Tooltip` | Icon buttons, truncated names, disabled controls | Never the only place for essential information |
| Dialog | `Dialog` | Source picker, create invite, watch notice, settings (full-screen variant) | Focus trapped; Esc closes; returns focus |
| Confirm dialog | `AlertDialog` | Delete message, kick, ban, revoke session, switch instance while in voice | Destructive action is not the default button |
| Drawer and sheet | `Dialog` (side and bottom variants) | Compact channel drawer, member sheet, voice sheet | Radix has no drawer; drag-to-dismiss is an extra, never the only way to close |
| Popover | `Popover` | User card, viewer list, emoji picker, connection details, E2EE details | |
| Dropdown menu | `DropdownMenu` | Header overflow, message "More", instance menu, status picker | Shares item definitions with the context menu |
| Context menu | `ContextMenu` | Messages, members, channels, voice participants, instances | Same items as "More"; Shift+F10 / Menu key |
| Select | `Select` | Device pickers, quality, expiry, role pickers | |
| Combobox | Custom (ARIA combobox) + `Popover` | Mention autocomplete, add-override picker, quick switcher | Radix has none; cmdk (MIT) is a candidate for the quick switcher (open item) |
| Checkbox | `Checkbox` | Forms, picker options | |
| Switch | `Switch` | Settings toggles, role permissions | Label at the start, switch at the end |
| Radio group | `RadioGroup` | Theme, accent swatches, transmit mode, source cards | |
| Segmented control | `RadioGroup` styled as segments | Audio preset, Focus/Grid, quality Auto/High/Low, permission Deny/Inherit/Allow | Radio semantics, so screen readers say "2 of 3" |
| Slider | `Slider` | Volumes, input gain, denoiser strength, sensitivity, release delay, text size | Shows value text; `aria-valuetext` with units; follows `dir` |
| Tabs | `Tabs` | Source picker (Screens/Windows), role editor, channel settings | |
| Accordion | `Accordion` | Advanced audio, permission groups | |
| Collapsible | `Collapsible` | Channel categories | |
| Scroll area | `ScrollArea` | Channel list, member list, settings navigation | Not the message list (native scroll + virtualiser) |
| Avatar | `Avatar` | Messages, lists, tiles | Initials fallback; presence shape cut into the end-bottom corner |
| Progress | `Progress` | Uploads, quota, connection test | |
| Meter | Custom (`role="meter"`) | Mic level, quota | Radix has none; clipping marker at the end |
| Form, Label | `Form`, `Label` | All forms | Field errors linked with `aria-describedby` |
| Toast | `Toast` | Device fallback, copied, auto-downgrade notices | Polite; F8 jumps to the viewport; never for errors that need action |
| Separator | `Separator` | Lists, menus | |
| Visually hidden | `VisuallyHidden` | Icon labels, live-region text | |
| Direction provider | `DirectionProvider` | App root | RTL for all primitives |
| Portal | `Portal` | Overlays | |
| Banner | Custom (`role="status"` or `role="alert"`) | Reconnecting, offline, update ready, preview-as-member | One at a time, highest priority wins |
| Badge and pill | Custom | Unread/mention counts, LIVE, CAM, E2EE, role pills | Accessible name spells the meaning ("3 mentions") |
| Presence indicator | Custom SVG | Avatars, member list | Shapes per §4 |
| Keyboard chip | Custom (`<kbd>`) | Keybinds, shortcut list, hints | |
| Keybind recorder | Custom on Button | Keybinds | Records keys or mouse buttons; Esc cancels, Backspace clears |
| Channel tree | Custom (`role="tree"`, roving tabindex) | Channel list | Categories expand/collapse; voice participants are nested items; type-ahead |
| Message feed | Custom on the virtualiser (`role="feed"`, `article` per message) | Message list | New messages announced through a separate polite live region, not the feed itself |
| Composer | Custom on `textarea` | Text channels | Rich editor vs textarea is an open item; textarea recommended for v1 (IME and RTL safety) |
| Video tile | Custom | Call view, stream view, filmstrip | Focusable; Enter focuses the stream; controls appear on hover and on focus |
| Source card | `RadioGroup.Item` | Source picker | Thumbnail, title, app icon |
| Data table | Native `<table>` | Sessions, invites, storage, effective permissions | Sortable headers are buttons with `aria-sort` |
| Skeleton | Custom | Loading lists | No shimmer under reduced motion |
| Empty state | Custom | Empty channels, no results | Heading, one sentence, at most one action |

Not used: `HoverCard` (hover-only content fails keyboard and touch users), `NavigationMenu`
and `Menubar` (the macOS app menu is native, 13 §4.3).

## 16. Implementation sketch (M1)

```css
/* generated from the token table; one block per theme */
:root, [data-theme="light"] { --color-bg: #FFFFFF; --color-text: #11161C; /* … */ }
[data-theme="dark"]         { --color-bg: #1D2026; --color-text: #ECEFF3; /* … */ }
[data-theme="hc"]           { --color-bg: #000000; --color-text: #FFFFFF; /* … */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { /* dark values, first paint */ } }
[data-accent="blue"][data-theme="light"] { --color-accent: #2557D6; /* … */ }
@media (forced-colors: active) { :root { --color-focus: Highlight; --color-accent: Highlight; /* … */ } }
```

Tailwind's theme maps semantic names to the variables (`bg-bg`, `bg-sidebar`, `text-muted`,
`ring-focus`, …). Tokens live in one source file in `packages/ui`; the CSS, the Tailwind
theme and the contrast test are generated from it. `tools/check_contrast.py` is the stand-in
until then.

## Open items

- Composer: plain `textarea` (recommended for v1) vs a rich editor (Lexical, Slate) for inline mention chips.
- Quick switcher library (cmdk vs custom combobox) once 12's "command palette in v1" is decided.
- Free custom accent colour (with automatic contrast correction) in addition to presets: later.
- Web shortcut defaults that browsers do not let pages intercept: check per browser in M1.
- App icon, logo and brand basics are a separate M0 item (17 §3), not drawn here.
