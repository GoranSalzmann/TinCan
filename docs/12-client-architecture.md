# 12. Client Architecture (shared web/desktop renderer)

One React application serves both the browser client and the Electron desktop
renderer (ADR-012). Desktop-only capabilities are reached through a
`PlatformBridge` (§9). Electron-specific details are in 13.

## 1. Goals

- A polished, fast, keyboard-friendly chat UI that feels native on desktop.
- Features appear or disappear based on server capabilities (04 §7, §10).
- Voice/video stays alive while the user navigates anywhere in the app.
- Works as a responsive web app on phones (no native mobile app, Q10).
- Accessible and localisable from day one (N-011, N-012).

## 2. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | React 18+ with TypeScript | Concurrent features for large lists |
| Build | Vite | Code splitting; separate chunk for voice (livekit-client + audio worklets + WASM) |
| State | Zustand (slices per module) | Simple, no boilerplate, selector-based rerenders |
| Server-state | Light custom layer (REST fetch + gateway-driven cache) | TanStack Query is acceptable for REST caching if it earns its keep; gateway events remain the invalidation source |
| Routing | React Router (or TanStack Router) | URLs: `/channels/:id`, `/invite/:code`, `/settings/*` |
| Styling | Tailwind + CSS variables for themes | Radix UI primitives for accessible dialogs, menus, tooltips, popovers |
| Lists | Virtualised (TanStack Virtual or equivalent) | Message list must handle tens of thousands of messages with stable scroll |
| Markdown | `remark/rehype` pipeline with strict allow-list, or a small safe parser | Never `dangerouslySetInnerHTML` of untrusted HTML; sanitised AST only |
| i18n | `i18next`-style message catalogs (ICU plural support) | English only at launch; all strings externalised |
| Icons/emoji | Lucide icons, bundled (design U10); native emoji picker data bundled | No third-party CDNs at runtime (privacy, offline-friendly) |
| Validation | zod schemas from `packages/shared` | Same schemas validate server payloads and incoming gateway events in dev builds |

## 3. Application structure

```
apps/web/src/
  shell/            layout, routing, auth gate, error boundaries, theme, command palette
  core/
    api/            REST client (typed from OpenAPI/zod), retry, auth header, error mapping
    gateway/        WebSocket client: connect, identify, resume, heartbeat, backoff, event bus
    capabilities/   capability store + hooks (useCapability)
    platform/       PlatformBridge interface + web implementation
    registry/       ClientHost: slot registry, store registry (04 §10)
    i18n/ settings/ notifications/ keybinds/
  modules/          one folder per client module
    accounts/ roles/ channels/ text-chat/ read-state/ uploads/ reactions/
    search/ link-previews/ voice/ video/ screenshare/ moderation/ audit-log/ admin/
  ui/               design-system components (Button, Dialog, Avatar, …)
```
A module exports `ClientModule` (04 §10). The shell loads
`modules/index.ts`, filters by capabilities, and calls `register`.

> **As built in M1.** The shell has the auth gate, the setup wizard, login and the empty layout; slots, the client module registry and the stores of §5 arrive with the first feature module (M2). Colour tokens are in `apps/web/src/theme/tokens.ts` (not `packages/ui`, which waits until a second consumer exists); `theme.test.ts` checks them against the style guide table and every contrast pairing, and the generated CSS is checked for staleness. The web session is a cookie plus gateway ticket (11 §1.2). The main bundle is about 515 kB because the shared zod schemas ship to the browser; split it when the voice chunk is added.

> **As built in M2.**
> - **State.** Three Zustand stores under `core/state/`: `community` (channels, roles, members, presence, permissions, synced settings), `chat` (message windows, pending sends, typing, read state) and `ui` (selected channel, window focus). `core/gateway/dispatch.ts` feeds them from the gateway; the window logic (`window.ts`: merge, prepend, around, live edge, edit last-writer-wins, unread, mentions) is pure and tested. A new READY after a non-resumable reconnect makes the open channel refetch its latest page and keep what is loaded.
> - **Message list.** TanStack Virtual with dynamic row heights; date separators, a "New" divider fixed at the read position when the channel opened, grouping by author within 7 minutes. Older pages keep the scroll position through an anchor row; the live edge is followed (and left alone once the reader scrolls up); `around=` loads for jumps.
> - **Rendering.** `modules/chat/markdown.tsx` parses a small subset into React elements, never HTML; only http, https and mailto links; a link whose text looks like another address, or whose host is an IDN, asks first.
> - **Composer.** Mentions are shown as `@Name` and sent as tokens (`mentions.ts`); drafts per channel in `localStorage`; uploads with XHR progress; slowmode countdown; typing over the gateway every 3 s.
> - **Notifications.** `notifications.ts` decides from the synced rules (default, per channel, timed mute) and the page title carries `(n)`; Web Push is not in v1.
> - **Settings** is a lazily loaded full-screen layer (design U9): account, appearance, notifications, storage, and, by permission, server, channels (with the overwrite editor), roles, members (with "what can this member do?") and invites. There is no `packages/ui` and no client module registry yet; the shell imports the M2 modules directly (a registry earns its keep when voice lands).
> - Bundle: main chunk 659 kB (205 kB gzip) before voice; the settings layer is a separate 35 kB chunk.

### 3.1 Slots (extension points the shell renders)
`sidebarSection`, `channelView(type)`, `channelHeaderAction`, `toolbarButton`,
`userPanelWidget`, `settingsPane`, `messageDecorator`, `messageActions`,
`composerAction`, `contextMenuItem(target)`, `memberListBadge`, `commandPaletteAction`.

## 4. Screen layout

```
┌───┬──────────────┬───────────────────────────────┬──────────────┐
│ S │ Channel list │  Channel header (name, topic) │ Member list  │
│ e │  Text        │───────────────────────────────│ (online/off, │
│ r │   # general  │  Message list (virtualised)   │  roles)      │
│ v │   # random   │                               │              │
│ e │  Voice       │                               │              │
│ r │   🔊 Lounge  │                               │              │
│   │     ◉ Ann 🖥 │───────────────────────────────│              │
│   │     ◉ Bo     │  Composer                     │              │
│   ├──────────────┤                               │              │
│   │ Voice panel  │                               │              │
│   │ User panel   │                               │              │
└───┴──────────────┴───────────────────────────────┴──────────────┘
```
- Voice channels show participants and "live" badges (screenshare/camera icons) inline without joining (R-031).
- **Voice panel** (bottom of channel list, while connected): current channel, connection quality, E2EE state, camera, share screen, disconnect. Visible in every view.
- **User panel** (under the voice panel, always visible): avatar, status, mute, deafen, settings. Mute and deafen live here so they work before joining (design U1).
- **Stream view:** clicking a live badge or "Watch" opens the stream in the main area (focus mode) with a filmstrip of other participants; grid mode when several streams are watched. Desktop: pop-out window (R-045).
- One server in the left rail in v1 (single community), but the rail exists for the desktop app's saved-instances switcher (13 §6).

Low-fi wireframes for these screens and the token and style guide are in
[design/](design/README.md) (approved 2026-10-28, 18 T23).

## 5. State & data flow

### 5.1 Stores (Zustand slices)
`session` (user, token handle, connection state), `capabilities`, `channels`,
`members`, `roles/permissions`, `messages` (per-channel windows), `presence`,
`readState`, `voice` (room state, participants, local controls), `ui` (selected
channel, panels), `settings` (persisted locally).

### 5.2 Gateway → store
- The gateway client emits typed events; modules subscribe in `register` and update their slice. Handlers must be idempotent (07 §5).
- Connection state machine: `connecting → identifying → ready → reconnecting(resume) → ready | reidentify`. UI shows a thin banner while reconnecting; actions queue (message sends keep their `nonce` and retry).
- After a non-resumable reconnect: refetch channels/roles/presence; **keep** cached message windows but verify the latest page; mark stale voice presence until the new READY lands.

### 5.3 Messages
- Per channel: a window of loaded messages (contiguous ID range). Scroll up loads older (`before`), reaching the live edge sets "at bottom" and auto-follows new messages; "jump to latest" and "new messages" divider supported.
- Optimistic send with `nonce`; failed send shows retry/delete inline.
- Edits/deletes update in place; deleted messages show "message deleted" only when moderators see them (policy choice).
- Jump-to-message (search results, reply references) loads `around=<id>` and replaces the window.
- Optional local cache (IndexedDB) of recent history per channel for instant open; validated against the server on open. v1 can skip persistent caching and rely on fast REST; flagged as an optimisation.

### 5.4 Unread & notifications
- Unread logic from `readState`; channel is unread if latest message ID > `lastReadId`. Marked read when the channel is focused, the window is focused and the user is at the bottom, throttled `ack`.
- Mentions raise badge counts; app-level badge (desktop dock/taskbar badge via bridge).
- Notification rules (settings): all messages / mentions only / none per channel; DND suppresses; desktop notifications only when the window isn't focused; sound options. Web uses the Notifications API after user opt-in; Web Push is not in v1.

### 5.5 Composer
Plain text with Markdown subset, auto-resize, paste/drag-drop uploads with progress and cancel, mentions autocomplete (`@user`, `@role`, `#channel`), emoji picker and `:shortcode:` autocomplete, reply-to bar, edit mode (↑ to edit last), draft persistence per channel (local), slowmode countdown, permission-aware disabling with an explanatory tooltip ("You can't send messages in this channel").

### 5.6 Message rendering
Markdown subset: bold, italic, strike, inline code, code blocks (syntax highlighting loaded lazily), blockquote, lists, links, spoilers, mentions, custom channel links. Links open through the bridge (external browser) with a confirm for lookalike/IDN domains. Images/attachments render with size placeholders (known width/height) to prevent layout shift. Link previews (if enabled) render from server-provided data only.

## 6. Voice client module (largest client module)

### 6.1 Components
- `VoiceManager` (singleton, non-React): owns the LiveKit `Room`, the audio pipeline (09), local track state, reconnection handling, and device management. React reads its state through a Zustand `voice` slice; UI never touches `Room` directly.
- `AudioPipeline`: builds the capture → denoise → gate → limiter graph, exposes meters and stats; implements fallback logic (09 §3).
- `StreamManager`: per remote video publication, subscription state, requested quality, tile attachment/detachment; ensures videos are unsubscribed when not displayed.
- `DeviceManager`: enumerates devices, handles hot-plug, remembers preferred devices by label+ID (IDs rotate), falls back to default with a toast.

### 6.2 State machine
`idle → fetchingToken → connecting → connected ⇄ reconnecting → disconnected(reason)`;
errors mapped to human messages (permission denied for mic, token rejected,
server unavailable, joined elsewhere).

### 6.3 Behaviours to specify precisely
- Joining another voice channel while connected: leave current first, then join; the UI shows a single spinner state.
- Closing the window/tab: tear down gracefully (`beforeunload` → leave); crash cases rely on the server's departure timeout.
- Muted-while-deafened and undeafen restoring prior mute state.
- Speaking indicators from LiveKit active-speaker events, with local mic-level override for self; under E2EE, from client-shared levels (10 §6).
- "Stats for nerds" overlay on stream tiles and in settings.
- Sharing bar (while publishing screen or camera) shows the viewer list (R-046, 08 §5.6); viewers see a "can see you watching" notice once.
- Each stream tile has its own audio volume/mute slider for `screen_share_audio` (R-047, 08 §5.7).
- Settings → Storage shows the user's upload usage against their quota (R-021).
- Screen-share start flow: web uses browser picker; desktop uses the in-app source picker (13 §4); preset selector before/after; "stop sharing" always available in the voice panel and via the OS-level indicator.
- Per-user volume/mute persisted by user ID in local settings.
- Auto-subscribe rules (08 §4.2): audio on; video on click.
- Keep-alive: voice must continue when the window is hidden/minimised (13 §7) and when the user switches channels or views.

## 7. Capabilities and permissions in the UI

- `useCapability("voice")`, `usePermission(channelId, "SEND_MESSAGES")` hooks; the permission store is recomputed from `PERMISSIONS_UPDATE` and role/channel events using the same pure function as the server (shared package, 11 §2.3) for instant UI response. The server remains authoritative; client mismatch just yields a `PERMISSION_DENIED` toast.
- Disabled-feature UI is removed, not greyed out, unless an explanation helps (e.g. permission denied in this channel).

## 8. Settings

Panes (each contributed by its module): My Account (profile, password, sessions),
Appearance (theme light/dark/system, density, font size, reduced motion),
Notifications, Voice & Audio (09 §9), Video, Keybinds (PTT, mute, deafen,
switch channel), Streaming defaults (preset, codec preference), Language,
Advanced (hardware acceleration toggle on desktop, developer mode, log export),
About (version, licences, **Source code link** for AGPL, server version).
Admin panes (permission gated): Server settings, Channels, Roles, Members,
Invites, Moderation/Audit log, Modules/Status.

Settings are split in two:
- **Synced (server-side, per user, 06 `user_setting`, 07 `/users/@me/settings`):** notification rules and per-channel mutes, theme, language. They follow the user across devices and update live via `USER_SETTINGS_UPDATE`.
- **Device-local:** audio/video devices, audio preset and denoiser choices, keybinds, per-user volume, hardware acceleration, window/layout state, drafts. These persist to `localStorage`/IndexedDB on web and to a file in the user-data directory on desktop (via the bridge) and never leave the device.

## 9. PlatformBridge

```ts
interface PlatformBridge {
  kind: "web" | "desktop";
  os: "windows" | "macos" | "linux" | "other";
  // storage
  secureStore: { get(k); set(k, v); delete(k) };       // OS keychain on desktop, in-memory/session on web
  settingsStore: { get; set };                         // durable local settings
  // windows & app
  openExternal(url: string): Promise<void>;
  setBadgeCount(n: number): void;
  showNotification(opts): void;
  flashFrame?(): void;
  setTrayState?(state: "idle" | "in-call" | "muted" | "unread"): void;
  popOutWindow?(view: PopOutRequest): Promise<void>;
  // input
  registerGlobalHotkey?(id, accelerator, handlers: {down, up}): Promise<Registration>;
  // capture
  getScreenSources?(): Promise<ScreenSource[]>;         // desktop picker data
  selectScreenSource?(id, opts: {audio: boolean}): Promise<void>;
  // power
  preventSleep?(on: boolean): void;
  onIdleChange?(cb): Unsubscribe;
  // updates
  updates?: { check(); onState(cb); install() };
  // diagnostics
  getVersionInfo(): VersionInfo;
}
```
The web implementation covers what browsers can do and omits the optional
members; UI checks for presence (`bridge.registerGlobalHotkey`) and explains
limits ("Push-to-talk only works while Tin Can is focused in the browser").

## 10. Performance

- Initial load budget: shell + text chat < ~300 KB gz JS; voice chunk lazy (livekit-client ≈ hundreds of KB, denoiser WASM/model several MB loaded on first voice join).
- Virtualised message and member lists; memoised message rows; image lazy loading with fixed placeholders.
- Avoid global rerenders: selector-based Zustand subscriptions; gateway events batched per animation frame.
- Memory: cap loaded messages per channel (e.g. 500 in memory outside the viewport window), release video elements on unwatch.
- Idle CPU target: < 1% with an open window and no activity; no polling timers beyond the gateway heartbeat.
- Measure with Lighthouse for web, plus custom marks (time-to-READY, time-to-first-message-render, voice-join latency).

## 11. Error handling & resilience

- Global error boundary per module slot, so a crashing voice panel doesn't take down text.
- REST errors mapped by `error.code` to localised messages; unknown errors show a generic message with a copyable request ID.
- Offline state: banner, send queue disabled with clear explanation, auto-recover.
- Version skew: on `CLIENT_TOO_OLD` show an upgrade screen (desktop: trigger update; web: refresh); on server newer-but-compatible, continue silently.
- Crash/diagnostics: local log ring buffer exportable from Advanced settings; no remote telemetry by default.

## 12. Accessibility & localisation

- Everything keyboard reachable; logical focus order; focus rings; roving tabindex in lists; skip links; shortcut cheat sheet (`Ctrl/Cmd+/`).
- ARIA live regions for new messages (polite) and voice events (join/leave announcements configurable); screen-reader labels for icon buttons; color contrast AA in all themes; respects `prefers-reduced-motion` and `prefers-color-scheme`.
- Right-to-left layout support via logical CSS properties; date/number formatting via `Intl`.

## 13. Theming

Design tokens as CSS variables (`--color-bg`, `--color-accent`, …); light, dark,
and a high-contrast theme at launch; accent colour customisable per user from checked presets (design U6). The
instance name/icon is Host-customisable. No third-party fonts loaded from
CDNs; the system font stack only, no bundled font in v1 (design U11). Token values,
contrast checks and the component inventory: [design/style-guide.md](design/style-guide.md).

## 14. Mobile web (responsive)

Breakpoints collapse the layout: channel list as a drawer, member list as a
sheet, voice panel as a bottom bar. The member list docks only at ≥ 1280 px and is
an overlay below that (design U8). Mobile browsers limit background audio and
screenshare publishing (not supported on most mobile browsers); the UI hides
unsupported controls using capability detection. Native mobile remains a future
option (Q10); keep audio and E2EE code free of desktop-only assumptions.

**Installable web app (PWA, added after M4).** The web client ships a manifest (`apps/web/public/manifest.webmanifest`, standalone display, icons from `apps/web/public/icons/`, regenerated from the SVG sources with `apps/web/scripts/gen-icons.mjs`) and a small service worker (`apps/web/public/sw.js`), so browsers offer "Install" on desktop and phones (HTTPS required). The worker caches only the hashed build files and the page shell: navigations go to the network first and fall back to the cached shell when the server cannot be reached, which then shows the normal "server unreachable" screen. It never touches `/api`, the gateway, files, avatars or LiveKit, so no chat data is kept on the device by the worker, and it needs no version bump because it does not precache. It is registered in production builds only. Caddy serves `/assets/*` as immutable and `/sw.js` and the manifest with `no-cache`. Not in scope: offline use of chat, push notifications (a later decision with server-side Web Push), background sync. The icon is a placeholder; the Host's own instance icon (12 §13) does not change it yet.

## 15. Build and release (web)

- Static assets with content hashes; served by Caddy with long-lived cache headers for hashed files and no-cache for `index.html`.
- A `/version.json` allows the app to detect a newer deployed client and prompt a refresh.
- Source maps kept for release debugging but not publicly served by default.
- Strict CSP (15): scripts from self only (WASM requires `wasm-unsafe-eval` or equivalent; verify), no inline scripts, connect-src limited to the instance origin and LiveKit URL.

## 16. Testing hooks (details in 16)

- Component tests (Vitest + Testing Library), module registration tests with fake capabilities, gateway client tests with a scripted fake server, Playwright e2e with Chromium fake media devices, visual regression for key screens (optional).
- Stable `data-testid`s on interactive elements; a "debug panel" (dev builds) to inject gateway events.

## Open items
- TanStack Query vs bespoke REST cache: decide at scaffold.
- Persistent local message cache (IndexedDB) in v1 or later.
- Command palette (`Ctrl/Cmd+K`): v1 nice-to-have for channel switching.
- Brand basics and the app icon (17 §3 M0); the rest of the visual design is approved in [design/](design/README.md).
