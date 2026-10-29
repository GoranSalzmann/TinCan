# 08. Voice, Video & Screenshare (LiveKit)

The media plane. LiveKit is a locked-in dependency (ADR-002), so this document
uses its concepts directly. Values marked **(verify)** are defaults from memory of
the LiveKit docs and MUST be checked against the pinned versions during the
spike phase (18 §D) before being treated as fact.

## 1. Goals recap

- Join/leave voice channels at will; camera and screenshare added on demand.
- Publisher upload independent of viewer count (N-003).
- Resilient to network change; works behind NAT/firewalls via TURN.
- Viewers opt in to watching a stream (R-041).
- Optional E2EE (10) must not break any of the above.

## 2. Building blocks

| Concept | Meaning for Tin Can |
|---|---|
| **Room** | One per voice channel, name `vc_<channelId>` |
| **Participant** | One user connection; `identity = userId` |
| **Track / Publication** | A published source: `microphone`, `camera`, `screen_share`, `screen_share_audio` |
| **Simulcast** | Publisher encodes several resolutions of the same video; SFU forwards the right one per subscriber |
| **Dynacast** | Publisher stops encoding layers nobody subscribes to |
| **Adaptive stream** | Subscriber asks for the layer matching the on-screen size / available bandwidth |
| **Data channel** | LiveKit messaging between participants; NOT used for anything sensitive (see 10 §7) |
| **Egress** | Optional recorder service (module `recording`) |

## 3. Server stack

> **Measured in M3 (18 §J, LiveKit v1.13.10).** `rtc.udp_port: 7882` is a single-port mux (every client used it); `bind_addresses` binds only the HTTP port (7881 and TURN stay public); TURN certificates are read at start only. Defaults confirmed: `room.empty_timeout` and `departure_timeout` are set per room by the app at creation (60 s and 20 s); `prometheus.port` replaces the deprecated `prometheus_port`; TURN relay range defaults to 30000–40000/udp. Dynacast keeps publisher upload flat in the number of viewers (1.57 / 1.55 / 1.51 Mbps for 1 / 3 / 5 viewers of a 1080p30 simulcast source) and stops the top layer when viewers only need small tiles.

> **Measured in M4 (18 §K).** Publisher upload for a 720p30 simulcast camera was 1290 kbps with one viewer, 1292 with two and 0 with none (layers go inactive about 8 s after the last viewer). A 374×209 tile received the 640×360 layer; High received 1280×720. Dynacast pauses a layer a few seconds after the last request, not at once.

### 3.1 Processes
`livekit-server` (SFU + built-in TURN) is configured via `livekit.yaml`. Redis is
optional for a single node without egress/ingress (05, 14).

### 3.2 Network ports (defaults, verify)
| Port | Proto | Purpose |
|---|---|---|
| 443 | TCP | HTTPS/WSS via Caddy (app, signaling to LiveKit under `/livekit`) |
| 7881 | TCP | WebRTC over TCP fallback (ICE-TCP) |
| 7882 | UDP | WebRTC media, single-port mux mode (preferred: one firewall rule) |
| 3478 | UDP | TURN/UDP (STUN) |
| 5349 or 443 | TCP/TLS | TURN/TLS for restrictive firewalls. Using 443 requires sharing with Caddy via SNI-based routing or a dedicated IP/hostname for TURN (decision T3/T4 in 14) |

Recommendation (T4): **single UDP mux port (7882)** plus TCP 7881 and TURN/TLS.
Fewer open ports beats a 10k-port range for self-hosters. The per-port mux has a
throughput ceiling on very large deployments; irrelevant at our scale.

`rtc.use_external_ip` or an explicit `node_ip` MUST be set for public hosts;
mis-detected IPs are the #1 cause of "connects but no audio". The startup
self-test (§10) checks this.

### 3.3 Room defaults (set via token/room options)
| Setting | Default | Notes |
|---|---|---|
| `emptyTimeout` | 60 s | Room is garbage-collected shortly after the last person leaves |
| `maxParticipants` | channel setting (default 25) | Enforced on join |
| `departureTimeout` | 20 s (verify) | Grace period for reconnect before participant is removed |
| Audio | Opus, DTX on, RED on | See 09 |
| Video codecs | VP8 baseline, VP9/H.264/AV1 opportunistic | §6 |

## 4. Client connection model

### 4.1 Join sequence
1. `POST /voice/channels/:id/join` → `{url, token, publishDefaults, e2ee?}`.
2. Create `Room` with options:
   - `adaptiveStream: true`, `dynacast: true`
   - `publishDefaults` from server response (simulcast layers, codecs, DTX/RED)
   - `audioCaptureDefaults`: processing disabled where we run our own (09)
   - `e2ee` options if the channel is encrypted (10)
3. `room.connect(url, token, { autoSubscribe: false })`.
4. Publish the processed microphone track (09).
5. Subscribe manually (see §5).

> **As built in M4.** `adaptiveStream` stays off: livekit-client cannot go back from a manual quality to the automatic one, so "Auto" reports the drawn tile size with `setVideoDimensions` (18 M4-3). Camera and screen tracks are stopped by the client when the server unpublishes them (M4-4).

### 4.2 Why manual subscription
With `autoSubscribe: true` the client would receive every video track
automatically, defeating "viewer opts in". So:
- On `TrackPublished` for **audio** (mic, screen audio): subscribe immediately, unless the local user is deafened.
- On `TrackPublished` for **video** (camera, screen): do NOT subscribe; show a "Watch" tile/button and an indicator in the channel sidebar.
- When the user clicks Watch: `publication.setSubscribed(true)`; unwatch → `false`. Screenshare audio follows its video: subscribe only when the video is watched (otherwise people hear a game they cannot see).
- Optionally a per-user preference "auto-watch cameras" and "auto-watch screenshares of people I follow".

### 4.3 Deafen and mute
- **Mute (self):** mute the local mic publication (`track.mute()`); stops sending (DTX/silence) and informs others (LiveKit propagates muted state).
- **Deafen (self):** locally unsubscribe from (or set volume 0 on) all remote audio; also mutes the mic by convention. Declared to others via gateway `voice.state` so they see an icon. Cosmetic honesty only; a hacked client could lie, which is acceptable.
- **Server mute:** `RoomService.mutePublishedTrack` plus a permission revoke so the user cannot simply unmute (permission `SPEAK` removed via `updateParticipant`); lifting restores it.

### 4.4 Reconnection

> **Measured in M3.** LiveKit sends the connected client a new token after join and after every permission change, with the current permissions; the app's token endpoint is therefore only for joining, and revocation is the server's `updateParticipant`/`removeParticipant` plus the reconciler (T25). A network drop of 3 s reconnects by ICE restart without a rejoin; an app restart does not drop the call.
- `livekit-client` performs ICE restarts and full reconnects automatically.
- Client UI states: connected, reconnecting (spinner on avatar), disconnected (offer rejoin).
- Token refresh: LiveKit may refresh tokens for connected participants itself (verify in D1). The app's `/voice/channels/:id/token` serves rejoins and re-checks CONNECT/permissions. Token expiry is not relied on for revocation (05 §6.2–6.3).
- Network switch (Wi-Fi ↔ Ethernet) must be tested explicitly (16).

### 4.5 One session per user
Same `identity` joining again (second device) displaces the first (LiveKit
behaviour for duplicate identity). The displaced client gets a clear
"You joined from another device" message. Joining a different voice channel
from the same client leaves the current room first.

## 5. Upload does not scale with viewers

### 5.1 Mechanism
- Publisher sends **one stream set** to the SFU. The SFU duplicates packets to each subscriber. Adding viewers adds server egress, not publisher upload.
- Publisher upload = sum of the encoded layers actually in demand. With **dynacast**, layers that no subscriber wants are not encoded or sent.
- Worst case upload = the sum of all published layers, bounded by the preset below, regardless of viewer count (1 or 20).

### 5.2 Screenshare presets
(All `contentHint: "detail"` for text/UI sharpness, or `"motion"` for games/video; user-selectable; default by detecting the source type is unreliable, so default to "detail" and let the user pick.)

| Preset | Resolution @ fps | Top layer bitrate cap | Layers published | Typical publisher upload |
|---|---|---|---|---|
| Low upload | 720p @ 15 | ~1.0 Mbps | 1 | ~1 Mbps |
| Standard (default) | 1080p @ 30 | ~3.5 Mbps | 2 (1080p + 540p ~0.6 Mbps) | ~4 Mbps |
| Smooth | 1080p @ 60 | ~6 Mbps | 2 | ~6.5 Mbps |
| Native/High (optional) | up to 1440p/4K @ 30 | admin-configurable cap | 1–2 | Host-capped |

The server decides **maximum allowed preset and bitrate** (per channel setting
and global cap `screenshare.maxBitrateKbps`), delivered in `publishDefaults`; the
client UI offers only presets within the cap.

Camera: 720p@30 default (≈1.2–1.7 Mbps top layer) with 3 simulcast layers
(720/360/180), because camera tiles are often small. Camera and screen both
active add up; the UI shows the estimated upload.

### 5.3 Codec choice
| Codec | Use | Notes |
|---|---|---|
| VP8 | Universal default, simulcast supported everywhere | Safe baseline |
| H.264 | Hardware encode on many laptops; good compatibility | Simulcast + hardware encode varies; offer as option |
| VP9 | Better quality per bit, SVC (scalable) in Chromium | CPU heavier; try for screenshare when both ends support |
| AV1 | Best compression, screen-content tools | Encode cost high; hardware encode only on newer GPUs; opt-in "experimental" |
Strategy: `videoCodec: vp8` with `backupCodec` for broad compatibility in v1;
codec preference configurable per Host; revisit VP9/AV1 SVC after spike D4 (E2EE + SVC interplay).

### 5.4 Viewer side controls
- **Adaptive stream:** subscribe resolution follows the rendered tile size; pop-out or fullscreen raises the requested layer.
- Manual quality override (Auto / High / Low) and "pause video" (unsubscribe) to save bandwidth.
- Frame-rate preference hint ("prefer smooth" vs "prefer sharp") passed as subscription settings where supported.

### 5.5 Server egress sizing
Egress ≈ Σ over streams × viewers × layer bitrate delivered.

| Scenario | Egress |
|---|---|
| 1 screenshare 1080p30 (~3.5 Mbps) × 5 viewers | ~17.5 Mbps |
| Same × 10 viewers | ~35 Mbps |
| 2 simultaneous shares × 8 viewers | ~56 Mbps |
| 10-person voice-only (Opus ~32 kbps + overhead ≈ 40 kbps) | ~10 × 9 × 40 kbps ≈ 3.6 Mbps |

Guidance for Host docs: a VPS with ≥ 1 Gbps port and generous or unmetered
transfer; a metered "1 TB/month" plan is consumed fast by heavy screenshare
(35 Mbps ≈ 15 GB/hour).

### 5.6 Viewer list for the sharer (R-046)
- Each viewer's client declares what it is watching using LiveKit **participant attributes** (e.g. `watching = "<publisherUserId>:<source>"`, set when the viewer subscribes, cleared on unwatch or leave; verify attribute API on the pinned SDK).
- The sharer's client reads attributes of all participants and shows "Watching: Ann, Bo" on the sharing bar, with a count badge. No server involvement and no new gateway event.
- Viewers see a one-time notice when they start watching ("<name> can see that you're watching") and a small eye indicator on streams they watch.
- **Limits, stated honestly:** the list is client-reported and best-effort. A modified client could watch without being listed. If enforceable visibility is ever required, the server must control subscription permissions per track (`updateSubscriptionPermissions`-style) and derive the list from that; not in v1.
- Under E2EE the attributes remain visible to the server (metadata, 10 §2).

> **As built in M4.** The attribute is `watching`, a comma separated list of `userId:camera` / `userId:screen` keys; any participant can read it (18 M4-7). Setting it needs `canUpdateMetadata`, which every permission update must keep (M4-1).

### 5.7 Stream audio volume (R-047)
Screenshare audio arrives as its own track (`screen_share_audio`), played in its own media element, so the viewer gets a separate volume slider (0–100%) and mute on the stream tile, independent of the sharer's per-user voice volume. Persisted locally per sharer. Subscribed only while the stream is watched (4.2).

## 6. Audio specifics in the media layer
(Processing is in 09; transport settings here.)

- Opus mono at 24–40 kbps speech target (use LiveKit speech audio preset, verify exact bitrate), in-band FEC and **RED** redundancy enabled for loss resilience, **DTX** on for bandwidth savings (disable in "music mode").
- Screenshare audio: separate `screen_share_audio` source, stereo, higher bitrate (≈ 64–96 kbps), **no** echo cancellation/noise suppression/AGC applied.
- Active-speaker detection from LiveKit (server-side audio level) drives the speaking indicators; local mic level drives the local indicator for zero-latency feedback.
- Per-user volume: client-side gain, 0–300 % (a Web Audio gain on the receive path followed by a limiter above 100 %, since `HTMLMediaElement.volume` stops at 100 %), persisted locally per user ID. Boosted speech is slightly more compressed and raises the noise with the voice.

## 7. Presence and state synchronisation

Sources of truth, from most to least authoritative:
1. LiveKit room state (what is physically connected).
2. App presence store (`kv`), updated by webhooks, reconciled every 30 s.
3. Client-side view of its own room via the LiveKit client.

Sidebar data flow: webhook → presence store → bus event `voice.participant.*`
→ gateway `VOICE_STATE_UPDATE` → clients. Published-source changes
(`track_published/unpublished`) update the "live" badge.

Stale-state protections: joined users are marked with `joinedAt`; entries not
seen in LiveKit for two reconciliations are dropped; the client trusts its own
LiveKit room list over the sidebar for the channel it is in. The same
reconciliation pass re-checks each participant's permissions (05 §6.3).

## 8. Permissions mapping

| Tin Can permission | LiveKit grant |
|---|---|
| CONNECT | `roomJoin`, `canSubscribe` |
| SPEAK | `canPublishSources` includes `microphone` |
| VIDEO | includes `camera` |
| SCREEN_SHARE | includes `screen_share`, `screen_share_audio` |
| MUTE_MEMBERS / MOVE_MEMBERS | server-side actions via RoomService (never in client tokens) |
| (none) | `canPublishData` = false for normal users (no use for data channels in v1); `canUpdateOwnMetadata` true |

Permission changes during a call are applied with `updateParticipant`
(and by disconnecting when CONNECT is lost), triggered by the `roles` event
(`PERMISSIONS_UPDATE`). If that call fails, the next reconciliation pass
(≤ 30 s) applies the change (18 T25).

> **As built in M4.** Server-wide caps `voice.camera.maxBitrateKbps` (1700) and `voice.screenshare.maxBitrateKbps` (6000) in `config.yaml`; the channel setting `maxScreenshareKbps` lowers the screen cap for one channel. All of them are delivered in `publishDefaults.video` and are advisory.

## 9. Voice channel settings (per channel, in `channel.settings`)

```json
{ "bitrateKbps": 40, "userLimit": 25, "videoAllowed": true,
  "screenshareAllowed": true, "maxScreenshareKbps": 6000, "e2ee": "inherit" }
```
`e2ee`: `inherit` (module default) | `required` | `off`. Changing E2EE setting
while people are connected forces a rejoin (10).

## 10. Connectivity diagnostics (K-01 mitigation)

1. **Server self-test** at boot and via `tincan doctor`: verifies external IP, that UDP 7882 and TCP 7881 are reachable (using a simple probe), TURN reachable on its TLS port, certificate valid.
2. **Client "Test connection"** in settings: attempts ICE candidates via host / srflx / relay and reports which paths work, mic/camera permissions, RTT and packet loss to the SFU, and gives plain-language fixes ("UDP seems blocked; you're using TCP/TURN, expect slightly higher latency").
3. In-call **quality indicator** per participant (LiveKit connection quality) and a "stats for nerds" panel (bitrate, codec, loss, jitter, selected candidate type).
4. Server logs a one-line summary per join: which transport (UDP/TCP/TURN) the client ended up using, for troubleshooting.

## 11. Failure modes

| Failure | Behaviour |
|---|---|
| LiveKit down at join | `UNAVAILABLE`; UI says voice is offline; text unaffected |
| App server restarts mid-call | Calls continue, encrypted ones included (keys are re-derived from the LiveKit room, 10 §4.1); presence rebuilt by reconciliation |
| Ban or permission change while the LiveKit API call fails | Next reconciliation pass removes or downgrades the participant and rotates the E2EE key (05 §6.3) |
| Webhook delayed/missed | Reconciliation within 30 s |
| Client loses network | Auto-reconnect up to the departure timeout; then dropped and shown as left |
| Publisher uplink collapses | LiveKit congestion control lowers layers; viewers see lower quality; UI shows "poor connection" on the stream |
| Viewer downlink poor | Adaptive stream drops to lower layer or pauses video; audio prioritised |
| Server CPU/egress saturated | Admin metrics alert; per-channel bitrate caps (§5.2) are the lever |

## 12. Recording (optional module `recording`)
- LiveKit Egress (room composite or track composite) → MP4/HLS into the storage port. Requires Redis.
- Hard-conflicts with E2EE rooms (10). UI shows a recording banner to all participants when active (consent), and a gateway event is dispatched.
- Disabled by default; not part of the first milestones (17).

## 13. Capacity planning table (for Host docs)

| Concurrent | Voice-only CPU | Screenshare notes |
|---|---|---|
| ≤ 25 in voice | negligible on 1–2 vCPU | egress dominates |
| 10 viewers of 2 streams | 2 vCPU comfortable (SFU forwards, does not transcode) | ≈ 70 Mbps egress |
Assumptions to validate in spike D1 (18).

## Open items
- Exact LiveKit config keys/values (ports, TURN, departure timeout) pinned after spike.
- VP9/AV1 SVC with E2EE (spike D4).
- Whether `canPublishData` should be enabled for in-room reactions/hand-raise (probably gateway instead).
- Pop-out viewer windows (R-045): Electron multi-window sharing one Room object vs a second connection (12/13).
