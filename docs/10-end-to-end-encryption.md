# 10. End-to-End Encryption (voice & video)

Scope (ADR-011): E2EE for **voice, camera and screenshare media**. Text is
protected by TLS and at-rest practices only; text E2EE is a non-goal for v1.
This doc states precisely what E2EE does and does not protect, so the UI and
docs never overclaim (K-11).

Facts about LiveKit's E2EE API are from memory of its documentation and are
**(verify)** items for spike D4.

## 1. What problem this solves

Without E2EE, the SFU decrypts SRTP and sees raw media. With E2EE, media frames
are encrypted by the sender before they enter WebRTC's packetizer, and decrypted
only by receivers. The SFU still forwards packets (it can read RTP headers and
some codec metadata it needs for simulcast/SVC) but cannot decode the audio or
video content.

## 2. Threat model

### Protects against
- A compromised or curious **LiveKit host/process** (e.g. LiveKit running on a separate, less-trusted machine, per topology C).
- A network attacker or hosting-provider employee who captures the media server's memory/traffic after TLS/DTLS termination.
- Accidental exposure through server-side tooling (debug dumps, packet captures at the SFU).

### Does NOT protect against
- **The app-server operator (the Host).** The app server mints and distributes the keys, so a Host who wants to can obtain them and, combined with LiveKit access, decrypt. In a friends-run instance where the Host and the LiveKit operator are the same person, E2EE adds protection only against outside compromise, not against the Host. This is stated plainly in the UI ("Encrypted so the media server can't read it. The server admin who manages keys is still trusted.").
- Malicious or modified clients, and other participants in the call (anyone in the call can record it).
- Metadata: who is in which room, when, track kinds, bitrates, IP addresses, timing, packet sizes.
- Data-channel payloads (not covered by frame encryption; we do not use data channels for anything sensitive, §7).
- Endpoint compromise (keylogger, screen capture malware).

### Why not stronger
A model where the Host cannot obtain keys needs client-generated keys with an
authenticated group key agreement (MLS or similar), identity key management,
and device verification. That is a large project and was explicitly scoped out.
The design leaves room for it (§9).

## 3. Mechanism

- **Frame-level encryption** via WebRTC Insertable Streams / `RTCRtpScriptTransform` in a Worker, wrapped by LiveKit's E2EE support (`E2EEOptions` with a `keyProvider` and a `worker`).
- Cipher: AES-GCM per frame with a per-sender nonce/IV and key index in the frame header, SFrame-style (verify).
- Codec-aware: header bytes needed by the SFU (e.g. for VP8/H.264/VP9/AV1 layer selection) are left unencrypted; payload encrypted. Simulcast, dynacast and adaptive stream continue to work (verify with spike D4, including VP9/AV1 SVC).
- **Key provider:** use the "shared key" model (`ExternalE2EEKeyProvider`-style): all participants in a room use a common symmetric key supplied by the app, with a key **index** to allow rotation without breaking in-flight frames.

Browser/runtime support: Chromium (and thus Electron) yes. Firefox and Safari
have partial support for the required transform APIs (verify at pin time). Policy:
if a channel is `e2ee: required` and the client lacks support, the join is refused
with a clear message; if `inherit` or `off`, join proceeds unencrypted for that
channel only when the channel is not required.

## 4. Key management

### 4.1 Derivation (resolves T6)

> **Confirmed in D4 (18 §J).** The room SID and room metadata are in the join response and identical for all participants, so a late joiner derives the same key from `secret + SID`; `createRoom` is idempotent and keeps metadata; the SID changes only after the room was empty past `empty_timeout`. E2EE with 3-layer simulcast and dynacast works (VP8). **T33 is closed:** the server's active-speaker events are identical with E2EE on, so server-side speaker detection works and the client-shared-levels fallback (§6) is dropped; speaking activity joins the metadata E2EE does not protect. Not tested: VP9/AV1 SVC, key index behaviour across sessions.
No per-room keys are stored in the database.

```
instanceSecret   : 32 random bytes, generated at first run, stored in config/secret store
roomSession      : the LiveKit room's ID (SID). The app creates the room explicitly on the
                   first join to an empty channel, so the SID exists before the first key
                   is minted; a room recreated after emptyTimeout gets a new SID
epoch            : integer in the LiveKit room's metadata, starts at 0, increments on rotation
roomKey(epoch)   = HKDF-SHA256(ikm = instanceSecret,
                               salt = roomSession,
                               info = "tincan/e2ee/v1/" + channelId + "/" + epoch,
                               len  = 32)
keyIndex         = epoch mod keyringSize          (keyringSize = 16, verify limit)
```
- `roomSession` and `epoch` live in the LiveKit room itself (its SID and its metadata), not in app memory or `kv`. Any app node, and the same node after a restart, derives the same key, so an app restart needs no rekey and encrypted calls continue untouched (18 T27; SID and metadata semantics verified in spike D4).
- Neither value is sensitive: participants can read room metadata, but the secret needed to derive keys never leaves the app config. Only the app (server API key) can change the metadata.
- `instanceSecret` rotation: supported by CLI (`tincan e2ee rotate-secret`), which forces a rotation in every active room (epoch bump, keys derived from the new secret).

### 4.2 Distribution
- Keys are delivered only over the authenticated, TLS-protected channel: in the REST join response (`e2ee: {keyIndex, key(base64), epoch}`) and, on rotation, via gateway event `E2EE_KEY_UPDATE {channelId, keyIndex, key, epoch}` to current participants only.
- Keys are never sent to users who lack CONNECT on that channel and never logged (redaction list in 05 §8).
- Key material in the client is kept in memory only, passed to the E2EE worker, never persisted to disk or localStorage.

### 4.3 Rotation policy
| Event | Action |
|---|---|
| Participant leaves voluntarily | Rotate **lazily**: rotate if the room still has others and ≥ 5 min have passed since last rotation (avoid churn) |
| Participant kicked/banned/permission revoked | **Immediate rotation** (forward secrecy against the removed user); also triggered by the reconciler when it removes someone the event path missed (05 §6.3) |
| Participant joins | No rotation needed (they get only the current key and can't decrypt past media) |
| Room empties | LiveKit closes the room after `emptyTimeout`; the next join creates a new room (new SID, epoch 0) |
| Periodic | Optional every N hours for long-lived rooms (default 6 h, configurable) |

Receivers keep the previous 1–2 keys briefly so late frames decrypt during a
rotation window; senders switch to the new index once acknowledged or after a
short grace delay.

Cost: each rotation is one small gateway message per participant. At our scale,
trivial.

> **As built in M5 (18 §M).** An encrypted room (`required`, or `inherit` while the server default is on) **refuses** a client that cannot encrypt, so no room mixes the two (M5-3). The derivation uses a random salt kept in the database, and `tincan e2ee rotate-secret` replaces that salt (M5-5); key index is `epoch mod 16`, set explicitly (M5-6). Verified with simulcast, dynacast and VP9 scalable video in the media test; AV1, Firefox and Safari are untested.

## 5. Channel E2EE modes

`channel.settings.e2ee` ∈ `inherit | required | off` and module config
`modules.voice.e2ee` (default for `inherit`):

| Mode | Behaviour |
|---|---|
| required | Join refused for clients that can't encrypt; recording/server features disabled for this channel |
| inherit + module true | Encrypt when client supports it |
| off | Plain SRTP via SFU (allows recording, server-side features) |

Changing the mode while the room is occupied: server closes the LiveKit room
(the rejoin creates a new one with a new SID) and forces connected clients to rejoin (they receive `VOICE_SERVER_DISCONNECT`
`{reason:"e2ee_mode_changed"}`) to avoid mixed encrypted/unencrypted states.

UI: a lock indicator on the channel and in the call; tooltip explains the model
(§2). No "verified" badges, because we have no verifiable identity layer.

## 6. Interaction with other modules

| Module | Interaction |
|---|---|
| `recording` | **Conflict.** Egress cannot decrypt. Boot error if `voice-e2ee` and `recording` are both globally enabled; per-channel: recording refused on E2EE-required channels (04 §5) |
| `screenshare` / `video` | Fully covered (all tracks encrypted); screenshare audio too |
| `voice` presence | Unaffected (metadata is visible by design) |
| Moderation | Server mute/kick still work (they act on the connection, not the content) |
| Speaker detection | Server-side audio level detection fails on encrypted audio. LiveKit's active-speaker events depend on server-visible audio levels; with E2EE the server cannot compute them. **Fallback:** clients compute local speaking level and share via participant attributes/metadata or the gateway (`voice.state`). Needs design in the spike (D4). Possibly unnecessary: LiveKit may read the RTP audio-level header extension, which frame encryption leaves in clear (18 T33) |
| Server-side thumbnails / transcoding | Not possible, not planned |
| Bots/transcription | Not possible (non-goal) |

Speaker-detection caveat is a real functional cost of E2EE; document it and
test it early.

## 7. What is explicitly not encrypted

- Gateway/REST traffic is protected by TLS only.
- LiveKit data channels (not used by Tin Can for sensitive content; `canPublishData` is off for normal users, 08 §8).
- Text messages, attachments, avatars.

## 8. Failure and edge cases

| Case | Behaviour |
|---|---|
| Client missed a rekey (network blip) | Receivers show frozen/silent from that sender; client requests the current key (`GET /voice/channels/:id/e2ee-key`) after a decrypt-failure threshold, retries; UI shows "re-syncing encryption" |
| Mismatched keys (bug) | Decrypt failures surface in stats; auto-rejoin after N seconds |
| Late joiner mid-rotation | Gets the latest epoch key in the join response |
| Clock skew | Irrelevant (counter-based, not time-based) |
| Key leak suspicion | Admin CLI: rotate instance secret (kills all sessions' keys) |
| Downgrade attack (strip E2EE) | Only the app server decides mode and server enforces `required`; a client cannot choose unencrypted for a required channel |

## 9. Future: stronger E2EE (not v1)

Path if the Host-is-trusted limitation becomes unacceptable:
1. Per-user device identity keys (stored in OS keychain), published to the server.
2. MLS (RFC 9420) group per voice session, the server acting only as a delivery service; the app server never sees epoch secrets.
3. Export MLS secret → media key via the same key-provider interface (the media layer already supports external keys).
4. Verification UX (safety numbers / key fingerprints).
The current key-provider seam (keys are injected into the client E2EE worker by
client code) means steps 1–3 replace only key derivation/distribution.

## 10. Testing

- Unit: HKDF derivation determinism, rotation schedule, same key re-derived after an app restart (no rekey).
- Integration: two clients with the right key hear/see each other; a client with a wrong key sees no content (decryption fails visibly); SFU capture shows undecodable payload.
- Rotation: kick during a call → kicked client can no longer decode after rotation; other clients continue without >1 s interruption.
- Simulcast/dynacast/adaptive stream with E2EE on (spike D4).
- Cross-platform: Electron on Windows/macOS/Linux; web in Chromium, plus Firefox/Safari behaviour recorded.

## Open items
- Verify keyring size and key-index semantics in the pinned LiveKit client.
- Active-speaker approach under E2EE (client-computed levels vs participant attributes).
- ~~Whether E2EE defaults to on~~ **Decided: on by default** (18 §F). Speaker-detection approach under E2EE still to be validated in spike D4.
- Browser support policy for Firefox/Safari (refuse vs allow-unencrypted on `inherit`).
