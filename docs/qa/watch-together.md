# Watch Together demo and QA checklist (proposed)

> **Status: written at the planning stage (2026-11-02); nothing here has been run.** The feature is not built. This is the checklist the build must satisfy, in the style of [m4.md](m4.md). Rows marked **(auto)** are covered by automated tests once built, **(you)** need a person at a real browser, **(people)** need a second person on another network, **(phone)** a real phone, **(YouTube)** a real YouTube account-less session on a normal video, **(VPS)** the deployed server. Design: [20](../20-watch-together-design.md). Plan: [21](../21-watch-together-plan.md).

## A. Local checks

```bash
pnpm install
pnpm check                                  # typecheck, lint, headers, tests, build, licences, secrets
pnpm build && sh tools/watch-test/docker.sh # two-browser media test (planned; needs Docker)
```

- [ ] `pnpm check` is green, including the simulator suite (20 s budget) and the SSRF and CSP tests.
- [ ] The watch media test ends with all steps passed and prints the measured position difference (max and p95).
- [ ] The existing `sh tools/media-test/docker.sh` still ends `26/26 passed` (voice and video unaffected).

## B. Module off (default)

- [ ] **(auto)** With `modules.watch.enabled: false` there is no watch channel type in the create dialog, `/capabilities` has no `features.watch`, the gateway answers `FEATURE_DISABLED`, and the generated Caddy `Content-Security-Policy` is byte-identical to 1.0.x.
- [ ] Turning it on and off again keeps the tables and the channels; the channel shows "not available" while off.

## C. Basics (HTML5 only, provider switches off)

- [ ] **(you)** Create a watch channel (needs `MANAGE_CHANNELS`); it appears for members with `VIEW_CHANNEL` and is a 404 for others.
- [ ] Add a link on an allowed host: it queues with the file name as title; a host not on the list is refused with a clear message and the "share your screen instead" hint.
- [ ] Opening the channel loads nothing from any provider (devtools network: no third-party requests) **(auto)**.
- [ ] **Join** starts the video; the viewer list shows you; leaving removes you.
- [ ] Two browsers: play, pause, seek, next stay within about one second **(you)**; the media test measures ≤ 150 ms **(auto)**.
- [ ] A late joiner lands on the current second without pausing the others.
- [ ] Reload the page while playing: you can rejoin and land in sync (a tap may be needed).
- [ ] Throttle one browser (devtools "Slow 3G"): the room waits up to 8 seconds and says who it is waiting for, then continues; that viewer shows "Out of sync" and can tap Resync.
- [ ] Hide a tab for a minute and return: it resyncs by itself.
- [ ] Item ends: the next item starts for everyone (autoplay on); with it off, the room pauses at 0.
- [ ] Reorder by drag and by the keyboard buttons; remove own item; a moderator removes another's; "Remove and block" blocks the ID or host and sweeps the queue.

## D. Permissions and control modes

- [ ] A member without `CONTROL_PLAYBACK` sees disabled controls; their native seek is reverted with a one-line explanation.
- [ ] `queuer` mode: only the adder of the current item and managers control; `managers` mode: only managers.
- [ ] Removing `ADD_WATCH_ITEMS` for a role takes effect on the next add; a timed-out member cannot add or control **(auto)**.
- [ ] A ban or kick removes the viewer within the reconciler interval even if the first attempt fails **(auto)**.
- [ ] Per-channel overwrites on the new bits work; overwrites on non-channel bits are ignored **(auto)**.
- [ ] Locking the queue stops adds with a clear message.

## E. Abuse limits

- [ ] 20 queued items per member and 200 per channel are enforced; add and command rate limits answer `429` with `retryAfterMs` **(auto)**.
- [ ] Pause spam from one member hits the limit; the audit shows the actor.
- [ ] One of two viewers cannot skip the item by sending `ended` **(auto)**.
- [ ] A viewer cannot hold the room more than 8 seconds or twice per item **(auto)**.
- [ ] Hostile titles (script tags, bidi overrides, 10,000 characters) show as inert text of at most 200 characters **(auto)**.

## F. YouTube (only when enabled) **(YouTube)**

- [ ] With the provider off at Host level: adding a YouTube link says "YouTube is not enabled on this server".
- [ ] With it on: opening the channel still makes no request to Google; pressing Join shows the notice first; accepting loads the player; declining loads nothing.
- [ ] Network capture before and after Join matches the S4 table (hosts, cookies); the notice text matches what was measured.
- [ ] The player shows in full with its own controls; nothing is drawn over it; the player is at least 200×200 (480×270 recommended).
- [ ] Two members stay within about 600 ms for 10 minutes on an ordinary video; a pre-roll ad on one member does not break the others, and that member catches up afterwards.
- [ ] A video with embedding disabled, a private video and an age-restricted video show a specific message to the affected viewer and do not stop the room.
- [ ] No error 153 with the shipped Referrer-Policy; `tincan doctor` agrees.
- [ ] Native seek by a member who may not control is reverted; by one who may control, it moves everyone.
- [ ] Declining the notice later (settings) stops YouTube items loading for that member.

## G. Phone and PWA **(phone)**

- [ ] The stage fits at 360 px width; the queue is a bottom sheet; **Join** is one large button and is also what lets sound play.
- [ ] iOS Safari: HTML5 video plays inline (`playsinline`); a remote play for a viewer who has not tapped shows "Tap to play".
- [ ] Android Chrome: same.
- [ ] Lock the screen and return: the viewer resyncs by itself; YouTube does not play in the background (by policy).
- [ ] Installed PWA: join, add a link, and rejoin after an app switch.
- [ ] Record what S5 found about speakers and microphone (echo) in the user guide.

## H. Voice alongside

- [ ] Join a voice channel, then a watch channel: the call stays up (bottom bar), the video plays, nobody is disconnected.
- [ ] With headphones there is no echo; with speakers, note the result; auto-duck lowers the video while someone speaks.
- [ ] Voice E2EE lock icon is unchanged; the watch channel shows the "not end-to-end encrypted" text and no lock.

## I. Uploads (only when W3 is built and enabled) **(you)**

- [ ] A member with `ADD_WATCH_FILES` queues an own mp4 and a webm; seeking works in Chromium, Firefox and Safari.
- [ ] A queued file is not collected as an orphan; deleting the item or the file ends the item and the room moves on.
- [ ] A member without the bit cannot see the option; quota errors are clear.
- [ ] Takedown drill: find an item by ID, remove the item and the file, see the audit entries.

## J. Server restart and failures

- [ ] **(VPS)** Restart the app while a room plays: within 15 seconds the room keeps playing; after a longer outage it comes back paused; clients re-join without errors.
- [ ] Disable the module while a room is active: viewers return to the channel list with a message.
- [ ] Break the oEmbed call (block the host): the add still succeeds with a placeholder title.

## K. Accessibility **(you)**

- [ ] Everything is reachable by keyboard; Space, arrows and `N` work only for members who may control, and never while typing.
- [ ] The seek bar announces "12 minutes 31 seconds of 45 minutes"; state changes are announced politely ("Alex paused", "Now playing …", "Waiting for Sam").
- [ ] Sync state has text and an icon, not only colour; `prefers-reduced-motion` is respected.

## L. Hosts

- [ ] `tincan doctor` reports the enabled providers, a missing CSP entry, a blocking Referrer-Policy for YouTube, and warns on `anyHttpsHost`.
- [ ] The admin guide describes enabling the module and each provider, what each sends to third parties, the host allow-list, the blocklist and the takedown procedure.
- [ ] Metrics from 20 §12 appear on `/metrics`; no item URL or title appears in info logs **(auto)**.
