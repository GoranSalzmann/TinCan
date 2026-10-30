// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  VideoPreset as LkVideoPreset,
  VideoQuality,
  type LocalTrackPublication,
  type RemoteTrackPublication,
  type TrackPublishOptions,
  type VideoTrack,
} from "livekit-client";
import { request } from "../api/client.js";
import { sendCommand, useSession } from "../session/store.js";
import { createE2eeWorker, decodeKey, e2eeSupported, RoomKeyProvider } from "./e2ee.js";
import { createPipeline, type Pipeline } from "./pipeline.js";
import { effectiveSettings, useAudioPrefs, type AudioPrefs } from "./prefs.js";
import { useVoice, type ActualInfo, type Quality, type SpecInfo, type VoiceNotice } from "./store.js";
import { clampVolume, limiterFor, loadVolumes, saveVolumes } from "./volume.js";
import { autoThreshold, NoiseFloor, PushToTalk, rms, VoiceActivity } from "./transmit.js";
import {
  encodeWatching,
  markWatchNoticeSeen,
  parseStreamKey,
  detectCodecSupport,
  resolveVideo,
  streamKey,
  useVideoPrefs,
  viewersFrom,
  watchNoticeSeen,
  WATCHING_ATTRIBUTE,
  type StreamQuality,
  type StreamSource,
  type Resolved,
  type VideoPrefs,
  uploadKbps,
} from "./video.js";
import type { VoiceJoinResponse } from "@tincan/shared";

/** `TrackSource` in LiveKit's protocol enum, which livekit-client does not re-export. */
const PROTOCOL_CAMERA = 1;
const PROTOCOL_MICROPHONE = 2;
const PROTOCOL_SCREEN_SHARE = 3;

const SOURCE_OF: Record<StreamSource, Track.Source> = {
  camera: Track.Source.Camera,
  screen: Track.Source.ScreenShare,
};
const streamSourceOf = (s: Track.Source): StreamSource | null =>
  s === Track.Source.Camera ? "camera" : s === Track.Source.ScreenShare ? "screen" : null;

/** Publish options for a preset: simulcast layers below the top one, and the top layer's cap (08 §5.2). */
function publishOptionsFor(source: StreamSource, r: Resolved): TrackPublishOptions {
  const p = r.preset;
  const encoding = { maxBitrate: p.kbps * 1000, maxFramerate: p.fps };
  const layers = p.layers.map((l) => new LkVideoPreset(l.width, l.height, l.kbps * 1000, l.fps));
  // Presets stay on VP8 with simulcast. A custom setting above 1080p30 uses VP9 (or hardware AV1) as one scalable
  // encoding, whose spatial layers the SFU and dynacast handle like simulcast; the SDK adds a VP8 backup for viewers
  // that cannot decode it. For these codecs the simulcast layer list has no effect.
  const codec: TrackPublishOptions = r.codec === "vp8" ? {} : { videoCodec: r.codec, simulcast: true };
  return source === "camera"
    ? { simulcast: layers.length > 0, videoEncoding: encoding, videoSimulcastLayers: layers, ...codec }
    : {
        simulcast: layers.length > 0,
        screenShareEncoding: encoding,
        screenShareSimulcastLayers: layers,
        ...codec,
        // Stream audio is stereo and music-like: no DTX or RED, higher bitrate (08 §6).
        forceStereo: true,
        dtx: false,
        red: false,
        audioPreset: { maxBitrate: 96_000 },
      };
}

const QUALITY: Record<string, Quality> = {
  [ConnectionQuality.Excellent]: "excellent",
  [ConnectionQuality.Good]: "good",
  [ConnectionQuality.Poor]: "poor",
  [ConnectionQuality.Lost]: "lost",
};

/**
 * One call at a time (08 §4.5): the Room, the audio pipeline and the transmit gate. The UI talks to it through
 * `actions.ts` and reads state from `useVoice`.
 */
class VoiceManager {
  #room: Room | null = null;
  #pipeline: Pipeline | null = null;
  #local: LocalAudioTrack | null = null;
  #ptt: PushToTalk | null = null;
  #meter: ReturnType<typeof setInterval> | null = null;
  #unsubPrefs: (() => void) | null = null;
  #leaving = false;
  #capKbps = 40;
  #volumes = loadVolumes();
  /** Receive path per person: gain then limiter, then a tap for the tests (D8 volume above 100 %). */
  #chains = new Map<string, { gain: GainNode; limiter: DynamicsCompressorNode }>();
  #playback: AudioContext | null = null;
  #cleanups: (() => void)[] = [];
  /** Streams the person asked to watch; kept across a camera being switched off and on (R-041). */
  #wanted = new Set<string>();
  #dims = new Map<string, { width: number; height: number }>();
  /** Frame encryption (10): the key provider and its worker exist only while the call is encrypted. */
  #keys: RoomKeyProvider | null = null;
  #e2eeWorker: Worker | null = null;
  #e2eeEpoch = -1;
  #decryptErrors: number[] = [];

  get room(): Room | null {
    return this.#room;
  }

  async join(channelId: string): Promise<void> {
    if (this.#room) await this.leave({ silent: true });
    const store = useVoice.getState();
    store.patch({
      status: "connecting",
      channelId,
      notice: null,
      speaking: {},
      quality: {},
      transport: null,
      ...VIDEO_RESET,
    });
    this.#wanted.clear();
    this.#dims.clear();
    this.#leaving = false;

    const grant = await request<VoiceJoinResponse>(
      "POST",
      `/voice/channels/${encodeURIComponent(channelId)}/join`,
      { body: { e2ee: e2eeSupported() } },
    );
    const prefs = useAudioPrefs.getState().prefs;
    const canSpeak = grant.publishDefaults.sources.includes("microphone");

    let pipeline: Pipeline | null = null;
    if (canSpeak) {
      try {
        pipeline = await createPipeline(prefs);
      } catch (err) {
        // No microphone or permission refused: listen-only rather than no call at all.
        const name = (err as DOMException).name;
        useVoice.getState().patch({ notice: name === "NotFoundError" ? "mic_missing" : "mic_denied" });
      }
    }
    this.#pipeline = pipeline;
    pipeline?.onDowngrade(() => useVoice.getState().patch({ notice: "denoiser_downgraded" }));

    const settings = effectiveSettings(prefs);
    // Our own context for playback, so a per-person gain above 1 is possible (HTMLMediaElement.volume stops at 1).
    this.#playback = new AudioContext({ latencyHint: "interactive" });
    void this.#playback.resume().catch(() => undefined);
    // The key is in place before connecting, so nothing is ever sent or received in the clear (10 §3).
    if (grant.e2ee) {
      this.#keys = new RoomKeyProvider();
      this.#e2eeWorker = createE2eeWorker();
      await this.#keys.setKeyAt(decodeKey(grant.e2ee.key), grant.e2ee.keyIndex);
      this.#e2eeEpoch = grant.e2ee.epoch;
    }
    const room = new Room({
      webAudioMix: { audioContext: this.#playback },
      adaptiveStream: false,
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
      publishDefaults: { dtx: settings.dtx, red: settings.dtx },
      ...(this.#keys && this.#e2eeWorker
        ? { e2ee: { keyProvider: this.#keys, worker: this.#e2eeWorker } }
        : {}),
    });
    this.#room = room;
    this.#wire(room);
    try {
      if (localStorage.getItem("tincan.debug"))
        (window as unknown as { __tincanVoice?: VoiceManager }).__tincanVoice = this;
    } catch {
      // no storage: no hook
    }

    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
      if (this.#keys) await room.setE2EEEnabled(true);
      useVoice.getState().patch({
        e2ee: this.#keys ? "on" : "off",
        e2eeEpoch: grant.e2ee?.epoch ?? null,
      });
    } catch (err) {
      await this.#teardown();
      throw err;
    }
    for (const p of room.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) this.#subscribeIfAudio(pub);

    this.#capKbps = grant.publishDefaults.audioBitrateKbps;
    const may = (s: string) => (grant.publishDefaults.sources as string[]).includes(s);
    useVoice.getState().patch({
      canCamera: may("camera"),
      canScreen: may("screen_share"),
      caps: {
        cameraKbps: grant.publishDefaults.video.cameraMaxKbps,
        screenKbps: grant.publishDefaults.video.screenshareMaxKbps,
      },
    });
    for (const p of room.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) this.#onPublished(pub, p.identity);
    if (pipeline) await this.#publishMic(room, prefs);
    useVoice.getState().patch({ status: "connected", muted: !pipeline, deafened: false });
    this.#announceSelf();
    void this.#detectTransport(room);
    this.#startMeter();

    // Changing device, preset or tier in settings applies live (W-21).
    let last = JSON.stringify(captureKey(prefs));
    this.#unsubPrefs = useAudioPrefs.subscribe((s) => {
      const key = JSON.stringify(captureKey(s.prefs));
      if (key !== last) {
        last = key;
        void this.#rebuildPipeline(s.prefs);
      } else {
        this.#pipeline?.setGainDb(s.prefs.inputGainDb);
        this.#startTransmitGate(s.prefs);
      }
    });
  }

  /**
   * Publishes the processed microphone. Also used when the server grants the right to speak mid-call: LiveKit unpublishes
   * a source when its permission is revoked, and nothing republishes it when the permission comes back.
   */
  async #publishMic(room: Room, prefs: AudioPrefs): Promise<void> {
    if (room.localParticipant.getTrackPublication(Track.Source.Microphone)) return;
    if (!this.#pipeline) {
      try {
        this.#pipeline = await createPipeline(prefs);
        this.#pipeline.onDowngrade(() => useVoice.getState().patch({ notice: "denoiser_downgraded" }));
      } catch {
        return;
      }
    }
    const settings = effectiveSettings(prefs);
    this.#local ??= new LocalAudioTrack(this.#pipeline.track, undefined, false);
    const cap = Math.min(settings.bitrateKbps, this.#capKbps);
    await room.localParticipant.publishTrack(this.#local, {
      source: Track.Source.Microphone,
      name: "microphone",
      dtx: settings.dtx,
      red: settings.dtx,
      audioPreset: { maxBitrate: cap * 1000 },
      stopMicTrackOnMute: false,
    });
    this.#startTransmitGate(prefs);
    if (!this.#meter) this.#startMeter();
  }

  /**
   * A new key from the server (10 §4.2). Setting it at its own index leaves the earlier keys in the keyring, so frames
   * sent just before the change still decrypt.
   */
  async setE2eeKey(k: { epoch: number; keyIndex: number; key: string }): Promise<void> {
    if (!this.#keys || k.epoch <= this.#e2eeEpoch) return;
    await this.#keys.setKeyAt(decodeKey(k.key), k.keyIndex);
    this.#e2eeEpoch = k.epoch;
    this.#decryptErrors = [];
    useVoice.getState().patch({ e2ee: "on", e2eeEpoch: k.epoch });
  }

  /** Decryption keeps failing: the rekey message may have been missed, so ask for the current key (10 §8). */
  async #resyncKey(): Promise<void> {
    const channelId = useVoice.getState().channelId;
    if (!channelId || !this.#keys) return;
    useVoice.getState().patch({ e2ee: "resyncing" });
    try {
      const k = await request<{ epoch: number; keyIndex: number; key: string }>(
        "GET",
        `/voice/channels/${encodeURIComponent(channelId)}/e2ee-key`,
      );
      if (k.epoch > this.#e2eeEpoch) await this.setE2eeKey(k);
      else useVoice.getState().patch({ e2ee: "on" });
    } catch {
      // The next burst of errors tries again.
    }
  }

  async leave(o: { keepNotice?: boolean; silent?: boolean } = {}): Promise<void> {
    this.#leaving = true;
    const had = this.#room !== null;
    await this.#teardown();
    const keep = o.keepNotice ? useVoice.getState().notice : null;
    useVoice.getState().patch({
      status: "idle",
      channelId: null,
      speaking: {},
      quality: {},
      localLevel: 0,
      transport: null,
      notice: keep,
      ...VIDEO_RESET,
    });
    this.#wanted.clear();
    if (had && !o.silent) void request("POST", "/voice/leave").catch(() => undefined);
    if (had && o.silent) void request("POST", "/voice/leave").catch(() => undefined);
  }

  async #teardown(): Promise<void> {
    this.#unsubPrefs?.();
    this.#unsubPrefs = null;
    if (this.#meter) clearInterval(this.#meter);
    this.#meter = null;
    for (const c of this.#cleanups.splice(0)) c();
    this.#chains.clear();
    this.#debugTaps.clear();
    void this.#playback?.close().catch(() => undefined);
    this.#playback = null;
    this.#ptt?.reset();
    this.#ptt = null;
    const room = this.#room;
    this.#room = null;
    this.#keys = null;
    this.#e2eeEpoch = -1;
    this.#decryptErrors = [];
    this.#local = null;
    this.#pipeline?.stop();
    this.#pipeline = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect().catch(() => undefined);
    }
    this.#e2eeWorker?.terminate();
    this.#e2eeWorker = null;
    document.querySelectorAll("audio[data-tincan-voice]").forEach((el) => el.remove());
  }

  // ---- state ---------------------------------------------------------------------------------

  setMuted(muted: boolean): void {
    useVoice.getState().patch({ muted });
    if (!muted && useVoice.getState().deafened) this.setDeafened(false);
    this.#applyTransmit();
    this.#announceSelf();
  }

  setDeafened(deafened: boolean): void {
    // Deafen also mutes by convention (08 §4.3); undeafening restores the mic unless it was muted before.
    useVoice.getState().patch({ deafened, ...(deafened ? { muted: true } : {}) });
    const room = this.#room;
    if (room) {
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.source === Track.Source.Microphone) void pub.setSubscribed(!deafened);
          // Stream audio follows its video: only streams being watched come back on undeafen (08 §4.2).
          if (pub.source === Track.Source.ScreenShareAudio)
            void pub.setSubscribed(!deafened && this.#wanted.has(streamKey(p.identity, "screen")));
        }
      }
    }
    this.#applyTransmit();
    this.#announceSelf();
  }

  setUserVolume(userId: string, volume: number): void {
    const v = clampVolume(volume);
    this.#volumes[userId] = v;
    saveVolumes(this.#volumes);
    this.#applyVolume(userId);
  }

  volumeOf(userId: string): number {
    return this.#volumes[userId] ?? 1;
  }

  #applyVolume(userId: string): void {
    const chain = this.#chains.get(userId);
    if (!chain) return;
    const v = this.volumeOf(userId);
    chain.gain.gain.value = useVoice.getState().streamMuted[userId] === true ? 0 : v;
    const l = limiterFor(v);
    chain.limiter.threshold.value = l.threshold;
    chain.limiter.knee.value = l.knee;
    chain.limiter.ratio.value = l.ratio;
    chain.limiter.attack.value = l.attack;
    chain.limiter.release.value = l.release;
  }

  /** Test hook (media test, `localStorage["tincan.debug"]`): energy per output channel after gain and limiter, per person. */
  #debugTaps = new Map<string, AnalyserNode[]>();
  /** For the media test: whether frame encryption is on in this room and which epoch's key is in use. */
  e2eeInfo(): { on: boolean; epoch: number } {
    return { on: this.#room?.isE2EEEnabled === true, epoch: this.#e2eeEpoch };
  }

  levels(userId: string): { left: number; right: number } | null {
    const taps = this.#debugTaps.get(userId);
    if (!taps) return null;
    const buf = new Float32Array(2048);
    const e = taps.map((a) => {
      a.getFloatTimeDomainData(buf);
      return buf.reduce((sum, x) => sum + x * x, 0);
    });
    return { left: e[0] ?? 0, right: e[1] ?? 0 };
  }

  #announceSelf(): void {
    const { muted, deafened } = useVoice.getState();
    sendCommand("voice.state", { muted, deafened });
  }

  // ---- transmit gate: mute and push to talk --------------------------------------------------

  #applyTransmit(): void {
    const local = this.#local;
    if (!local) return;
    const { muted } = useVoice.getState();
    const prefs = useAudioPrefs.getState().prefs;
    const open = !muted && (prefs.transmitMode === "vad" || (this.#ptt?.open ?? false));
    if (open) void local.unmute();
    else void local.mute();
  }

  #startTransmitGate(prefs: AudioPrefs): void {
    this.#ptt?.reset();
    for (const c of this.#cleanups.splice(0)) c();
    this.#ptt = null;
    if (prefs.transmitMode === "ptt") {
      const ptt = new PushToTalk({
        releaseDelayMs: prefs.pttReleaseDelayMs,
        onChange: (open) => {
          useVoice.getState().patch({ transmitting: open });
          if (prefs.pttCues) this.#cue(open);
          this.#applyTransmit();
        },
      });
      this.#ptt = ptt;
      const editable = (t: EventTarget | null) =>
        t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const down = (e: KeyboardEvent) => {
        if (e.code === prefs.pttKey && !e.repeat && !editable(e.target)) ptt.down();
      };
      const up = (e: KeyboardEvent) => {
        if (e.code === prefs.pttKey) ptt.up();
      };
      const reset = () => ptt.reset();
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      window.addEventListener("blur", reset);
      document.addEventListener("visibilitychange", reset);
      this.#cleanups.push(() => {
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
        window.removeEventListener("blur", reset);
        document.removeEventListener("visibilitychange", reset);
      });
    } else {
      useVoice.getState().patch({ transmitting: false });
    }
    this.#applyTransmit();
  }

  #cue(open: boolean): void {
    const ctx = this.#pipeline?.context;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = open ? 880 : 587;
    g.gain.value = 0.04;
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  }

  // ---- level meter and local speaking indicator ----------------------------------------------

  #startMeter(): void {
    const pipeline = this.#pipeline;
    const self = useSession.getState().user?.id;
    if (!pipeline || !self) return;
    // The window (4096 samples, 85 ms) is longer than the tick, so no stretch of the published signal is skipped.
    const buf = new Float32Array(pipeline.analyser.fftSize);
    const noise = new NoiseFloor();
    const vad = new VoiceActivity(autoThreshold(0.002));
    this.#meter = setInterval(() => {
      pipeline.analyser.getFloatTimeDomainData(buf);
      const raw = rms(buf);
      const level = Math.min(1, raw * 4);
      const prefs = useAudioPrefs.getState().prefs;
      vad.setThreshold(prefs.vadThreshold ?? autoThreshold(noise.update(raw)));
      if (prefs.vadThreshold !== null) noise.update(raw);
      const s = useVoice.getState();
      const sending = !s.muted && (prefs.transmitMode === "vad" || s.transmitting);
      const speaking = vad.update(raw, Date.now()) && sending;
      if (s.speaking[self] !== speaking || Math.abs(s.localLevel - level) > 0.02) {
        useVoice.getState().patch({ localLevel: level, speaking: { ...s.speaking, [self]: speaking } });
      }
    }, 40);
  }

  async #rebuildPipeline(prefs: AudioPrefs): Promise<void> {
    const local = this.#local;
    if (!local) return;
    try {
      const next = await createPipeline(prefs);
      const old = this.#pipeline;
      await local.replaceTrack(next.track, false);
      this.#pipeline = next;
      next.onDowngrade(() => useVoice.getState().patch({ notice: "denoiser_downgraded" }));
      old?.stop();
      if (this.#meter) clearInterval(this.#meter);
      this.#startMeter();
      this.#startTransmitGate(prefs);
    } catch {
      // keep the current pipeline when the new device cannot be opened
    }
  }

  // ---- room events ---------------------------------------------------------------------------

  /** Voice is received at once; stream audio only together with its video (08 §4.2). */
  #subscribeIfAudio(pub: RemoteTrackPublication): void {
    if (pub.source === Track.Source.Microphone && !useVoice.getState().deafened) void pub.setSubscribed(true);
  }

  /** A remote publication appeared (or was there when we joined): audio now, video waits for "Watch". */
  #onPublished(pub: RemoteTrackPublication, identity: string): void {
    this.#subscribeIfAudio(pub);
    const source = streamSourceOf(pub.source);
    if (!source) return;
    const key = streamKey(identity, source);
    if (source === "camera" && useVideoPrefs.getState().prefs.autoWatchCameras) this.watch(identity, source);
    else if (this.#wanted.has(key)) this.#applySubscription(key);
  }

  // ---- watching (opt-in), quality, stream audio ------------------------------------------------

  #publicationsOf(key: string): { video?: RemoteTrackPublication; audio?: RemoteTrackPublication } {
    const k = parseStreamKey(key);
    const p = k ? this.#room?.remoteParticipants.get(k.userId) : undefined;
    if (!k || !p) return {};
    return {
      video: p.getTrackPublication(SOURCE_OF[k.source]),
      audio: k.source === "screen" ? p.getTrackPublication(Track.Source.ScreenShareAudio) : undefined,
    };
  }

  #applySubscription(key: string): void {
    const { video, audio } = this.#publicationsOf(key);
    const want = this.#wanted.has(key);
    void video?.setSubscribed(want);
    void audio?.setSubscribed(want && !useVoice.getState().deafened);
    if (want) this.#applyQuality(key);
  }

  #announceWatching(): void {
    const room = this.#room;
    if (!room || room.state !== ConnectionState.Connected) return;
    void room.localParticipant
      .setAttributes({ [WATCHING_ATTRIBUTE]: encodeWatching(this.#wanted) })
      .catch((err) => console.warn("voice: could not publish what this client watches", err));
  }

  /** Opt in to a stream: the only thing that makes video (and a share's audio) download. */
  watch(userId: string, source: StreamSource): void {
    const key = streamKey(userId, source);
    this.#wanted.add(key);
    const st = useVoice.getState();
    st.patch({
      watching: { ...st.watching, [key]: true },
      watchNotice: st.watchNotice ?? (watchNoticeSeen() ? null : userId),
    });
    this.#applySubscription(key);
    this.#announceWatching();
  }

  unwatch(userId: string, source: StreamSource): void {
    const key = streamKey(userId, source);
    if (!this.#wanted.delete(key)) return;
    this.#dims.delete(key);
    const st = useVoice.getState();
    const { [key]: _w, ...watching } = st.watching;
    const { [key]: _q, ...streamQuality } = st.streamQuality;
    st.patch({ watching, streamQuality, rev: st.rev + 1 });
    this.#applySubscription(key);
    this.#announceWatching();
  }

  dismissWatchNotice(): void {
    markWatchNoticeSeen();
    useVoice.getState().patch({ watchNotice: null });
  }

  setStreamQuality(key: string, q: StreamQuality): void {
    const st = useVoice.getState();
    st.patch({ streamQuality: { ...st.streamQuality, [key]: q } });
    this.#applyQuality(key);
  }

  /** The surface tells how big the video is drawn; "auto" asks for the layer that fits (08 §5.4). */
  reportSize(key: string, width: number, height: number): void {
    this.#dims.set(key, { width: Math.ceil(width), height: Math.ceil(height) });
    if ((useVoice.getState().streamQuality[key] ?? "auto") === "auto") this.#applyQuality(key);
  }

  #applyQuality(key: string): void {
    const pub = this.#publicationsOf(key).video;
    if (!pub || !pub.isDesired) return;
    const q = useVoice.getState().streamQuality[key] ?? "auto";
    pub.setEnabled(q !== "paused");
    if (q === "high") pub.setVideoQuality(VideoQuality.HIGH);
    else if (q === "low") pub.setVideoQuality(VideoQuality.LOW);
    else if (q === "auto") {
      const d = this.#dims.get(key);
      const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
      pub.setVideoDimensions(
        d
          ? { width: Math.ceil(d.width * dpr), height: Math.ceil(d.height * dpr) }
          : { width: 320, height: 180 },
      );
    }
  }

  setStreamMuted(key: string, muted: boolean): void {
    const st = useVoice.getState();
    st.patch({ streamMuted: { ...st.streamMuted, [key]: muted } });
    this.#applyVolume(key);
  }

  /** The video track to draw for a stream: our own camera or share, or the remote one once subscribed. */
  videoTrack(key: string): VideoTrack | undefined {
    const room = this.#room;
    const k = parseStreamKey(key);
    if (!room || !k) return undefined;
    if (k.userId === room.localParticipant.identity) {
      return room.localParticipant.getTrackPublication(SOURCE_OF[k.source])?.videoTrack;
    }
    return this.#publicationsOf(key).video?.videoTrack;
  }

  /** Test hook: what this client asked the server to send for a stream. */
  requested(key: string): Record<string, unknown> | null {
    const pub = this.#publicationsOf(key).video as unknown as Record<string, unknown> | undefined;
    return pub
      ? {
          dims: pub.requestedVideoDimensions,
          quality: pub.requestedMaxQuality,
          disabled: pub.requestedDisabled,
          subscribed: pub.subscribed,
        }
      : null;
  }

  /** Test hook: which remote tracks this client receives right now, as `identity:source`. */
  subscriptions(): string[] {
    const out: string[] = [];
    for (const p of this.#room?.remoteParticipants.values() ?? [])
      for (const pub of p.trackPublications.values())
        if (pub.isSubscribed) out.push(`${p.identity}:${pub.source}`);
    return out.sort();
  }

  /** Test hook next to `levels`: what is being received for a stream, from the receiver's own statistics. */
  async streamStats(
    key: string,
  ): Promise<{ width: number; height: number; fps: number; codec: string } | null> {
    const s = await (
      this.videoTrack(key) as { getReceiverStats?: () => Promise<unknown> } | undefined
    )?.getReceiverStats?.();
    const r = s as
      { frameWidth?: number; frameHeight?: number; framesPerSecond?: number; mimeType?: string } | undefined;
    return r
      ? {
          width: r.frameWidth ?? 0,
          height: r.frameHeight ?? 0,
          fps: r.framesPerSecond ?? 0,
          codec: r.mimeType ?? "",
        }
      : null;
  }

  // ---- camera and screen share ---------------------------------------------------------------

  async setCamera(on: boolean): Promise<void> {
    const room = this.#room;
    const st = useVoice.getState();
    if (!room) return;
    if (!on) {
      // setCameraEnabled(false) only mutes the track, and turning it on again would reuse the old capture and encoding:
      // a changed preset, resolution or codec would never apply. Unpublish and stop it for real.
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true).catch(() => undefined);
      st.patch({ cameraOn: false, cameraSpec: null });
      return;
    }
    const prefs = useVideoPrefs.getState().prefs;
    const r = await this.#resolve("camera");
    if (!r) return void st.patch({ notice: "camera_failed" });
    const preset = r.preset;
    try {
      await room.localParticipant.setCameraEnabled(
        true,
        {
          // "ideal": a camera that was unplugged falls back to the default one instead of failing (W-21).
          deviceId: prefs.cameraDeviceId ? { ideal: prefs.cameraDeviceId } : undefined,
          resolution: { width: preset.width, height: preset.height, frameRate: preset.fps },
        },
        publishOptionsFor("camera", r),
      );
      useVoice.getState().patch({ cameraOn: true, cameraSpec: specInfo(r) });
      this.#startActualPoll();
    } catch (err) {
      const name = (err as DOMException).name;
      useVoice.getState().patch({
        cameraOn: false,
        notice:
          name === "NotFoundError"
            ? "camera_missing"
            : name === "NotAllowedError"
              ? "camera_denied"
              : "camera_failed",
      });
    }
  }

  /** Changing the camera or its preset while on: switch the device in place, republish for a new preset. */
  async applyCameraPrefs(prev: VideoPrefs): Promise<void> {
    const room = this.#room;
    if (!room || !useVoice.getState().cameraOn) return;
    const prefs = useVideoPrefs.getState().prefs;
    const quality = (p: VideoPrefs) =>
      p.cameraPreset === "custom" ? JSON.stringify(p.cameraCustom) : p.cameraPreset;
    // A new resolution, rate, bitrate or codec needs a new capture and a new encoder: republish.
    if (prefs.cameraPreset !== prev.cameraPreset || quality(prefs) !== quality(prev)) {
      await this.setCamera(false);
      await this.setCamera(true);
    } else if (prefs.cameraDeviceId && prefs.cameraDeviceId !== prev.cameraDeviceId) {
      await room.switchActiveDevice("videoinput", prefs.cameraDeviceId).catch(() => undefined);
    }
  }

  /**
   * Screen share through the browser's own picker (W-16). Cancelling the picker is not an error. Audio is only
   * available where the browser offers it: tab audio in Chromium, system audio on Windows and ChromeOS, none in
   * Firefox or Safari (docs/18 §K).
   */
  async startScreenShare(o: { hint: "detail" | "motion"; audio: boolean }): Promise<void> {
    const room = this.#room;
    const st = useVoice.getState();
    if (!room) return;
    const r = await this.#resolve("screen");
    if (!r) return void st.patch({ notice: "screen_failed" });
    const preset = r.preset;
    try {
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: o.audio
            ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            : false,
          resolution: { width: preset.width, height: preset.height, frameRate: preset.fps },
          contentHint: o.hint,
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          systemAudio: "include",
          suppressLocalAudioPlayback: true,
        },
        publishOptionsFor("screen", r),
      );
      this.#noteLocalShare(r, o.hint);
      this.#startActualPoll();
    } catch (err) {
      const name = (err as DOMException).name;
      if (name === "NotAllowedError" || name === "AbortError") return; // the person cancelled the picker
      useVoice.getState().patch({ notice: "screen_failed" });
    }
  }

  async stopScreenShare(): Promise<void> {
    await this.#room?.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
    useVoice.getState().patch({ screenOn: false, share: null });
  }

  /** Quality and optimisation while live, within the cap; the picker is not shown again (W-13). Audio is fixed at start. */
  async updateScreenShare(o: { hint: "detail" | "motion" }): Promise<void> {
    const room = this.#room;
    const track = room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    const st = useVoice.getState();
    if (!room || !track) return;
    // The codec was chosen when the share started and cannot change without a new capture: only size, rate, bitrate and
    // hint move. The simulcast ratios (1, 1/2, 1/4) stay, so the lower layers follow a new capture size by themselves.
    const r = await this.#resolve("screen", st.share?.spec?.codec);
    if (!r) return;
    const preset = r.preset;
    track.mediaStreamTrack.contentHint = o.hint;
    await track.mediaStreamTrack
      .applyConstraints({
        frameRate: preset.fps,
        width: { ideal: preset.width },
        height: { ideal: preset.height },
      })
      .catch(() => undefined);
    const sender = track.sender;
    if (sender) {
      const params = sender.getParameters();
      // Simulcast layers go smallest to largest (q, h, f); a single layer is the top one.
      const bitrates = [...preset.layers.map((l) => l.kbps).reverse(), preset.kbps];
      const offset = Math.max(0, params.encodings.length - bitrates.length);
      params.encodings.forEach((e, i) => {
        e.maxBitrate = (bitrates[i - offset] ?? preset.kbps) * 1000;
      });
      await sender.setParameters(params).catch(() => undefined);
    }
    this.#noteLocalShare(r, o.hint);
  }

  /** The chosen preset or custom setting for a source, within the cap, with the codec this browser can use. */
  async #resolve(source: StreamSource, keepCodec?: string): Promise<Resolved | null> {
    const prefs = useVideoPrefs.getState().prefs;
    const caps = useVoice.getState().caps;
    const support = await detectCodecSupport();
    const r = resolveVideo(
      source,
      source === "camera" ? prefs.cameraPreset : prefs.screenPreset,
      source === "camera" ? prefs.cameraCustom : prefs.screenCustom,
      source === "camera" ? caps.cameraKbps : caps.screenKbps,
      keepCodec === "vp8" ? { vp9: false, av1Hardware: false } : support,
    );
    return r;
  }

  #actualTimer: ReturnType<typeof setInterval> | null = null;

  /** Every 2 s while something is published: what the browser captures and what the encoder sends (requested vs actual). */
  #startActualPoll(): void {
    if (this.#actualTimer) return;
    const read = async (src: Track.Source): Promise<ActualInfo | null> => {
      const track = this.#room?.localParticipant.getTrackPublication(src)?.videoTrack;
      if (!track) return null;
      const s = track.mediaStreamTrack.getSettings();
      const sent = (await track.getSenderStats().catch(() => []))
        .filter((x) => x.frameWidth > 0)
        .sort((a, b) => b.frameWidth - a.frameWidth)[0];
      return {
        captureWidth: s.width ?? 0,
        captureHeight: s.height ?? 0,
        captureFps: Math.round(s.frameRate ?? 0),
        sentWidth: sent?.frameWidth ?? 0,
        sentHeight: sent?.frameHeight ?? 0,
        sentFps: Math.round(sent?.framesPerSecond ?? 0),
        limit: sent?.qualityLimitationReason ?? "none",
      };
    };
    this.#actualTimer = setInterval(() => {
      const st = useVoice.getState();
      if (!st.cameraOn && !st.screenOn) {
        clearInterval(this.#actualTimer!);
        this.#actualTimer = null;
        st.patch({ actual: { camera: null, screen: null } });
        return;
      }
      void Promise.all([
        st.cameraOn ? read(Track.Source.Camera) : null,
        st.screenOn ? read(Track.Source.ScreenShare) : null,
      ]).then(([camera, screen]) => {
        const next = { camera, screen };
        if (JSON.stringify(next) !== JSON.stringify(useVoice.getState().actual))
          useVoice.getState().patch({ actual: next });
      });
    }, 2000);
  }

  #noteLocalShare(r: Resolved, hint: "detail" | "motion"): void {
    const presetId = r.preset.id;
    const lp = this.#room?.localParticipant;
    const video = lp?.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
    const surface = video?.mediaStreamTrack.getSettings()?.displaySurface;
    useVoice.getState().patch({
      screenOn: true,
      share: {
        preset: presetId,
        hint,
        audio: !!lp?.getTrackPublication(Track.Source.ScreenShareAudio),
        surface: surface === "monitor" || surface === "window" || surface === "browser" ? surface : null,
        spec: specInfo(r),
      },
    });
  }

  #onLocalUnpublished(pub: LocalTrackPublication): void {
    // The room keeps tracks running after an unpublish (the microphone is republished); camera and screen must stop,
    // or the camera light stays on after a permission loss.
    if (pub.source === Track.Source.Camera) {
      pub.track?.stop();
      useVoice.getState().patch({ cameraOn: false });
    } else if (pub.source === Track.Source.ScreenShare) {
      pub.track?.stop();
      useVoice.getState().patch({ screenOn: false, share: null });
    } else if (pub.source === Track.Source.ScreenShareAudio) {
      pub.track?.stop();
    }
  }

  #refreshViewers(room: Room): void {
    const everyone = [room.localParticipant, ...room.remoteParticipants.values()];
    useVoice.getState().patch({ viewers: viewersFrom(everyone) });
  }

  #chain(track: RemoteAudioTrack, userId: string, ctx: AudioContext): void {
    // `userId` is a person for voice and a stream key (`userId:screen`) for stream audio: separate volumes (R-047).
    const gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    this.#chains.set(userId, { gain, limiter });
    this.#applyVolume(userId);
    track.setWebAudioPlugins([gain, limiter]);
    try {
      if (localStorage.getItem("tincan.debug")) {
        const split = ctx.createChannelSplitter(2);
        limiter.connect(split);
        this.#debugTaps.set(
          userId,
          [0, 1].map((i) => {
            const an = ctx.createAnalyser();
            an.fftSize = 2048;
            split.connect(an, i);
            return an;
          }),
        );
        (window as unknown as { __tincanVoice?: VoiceManager }).__tincanVoice = this;
      }
    } catch {
      // no storage: no hook
    }
  }

  #wire(room: Room): void {
    // Audio is subscribed as soon as it is published; video will wait for "Watch" in M4 (08 §4.2).
    room.on(RoomEvent.TrackPublished, (pub, participant) => this.#onPublished(pub, participant.identity));
    room.on(RoomEvent.TrackUnpublished, (pub, participant) => {
      const source = streamSourceOf(pub.source);
      if (!source) return;
      // A share that ends is over; a camera that is switched off and on keeps the person's choice.
      if (source === "screen") this.unwatch(participant.identity, source);
      else useVoice.getState().patch({ rev: useVoice.getState().rev + 1 });
      this.#dims.delete(streamKey(participant.identity, source));
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub) => this.#onLocalUnpublished(pub));
    room.on(RoomEvent.ParticipantAttributesChanged, () => this.#refreshViewers(room));
    room.on(RoomEvent.ParticipantConnected, () => this.#refreshViewers(room));
    room.on(RoomEvent.ParticipantDisconnected, () => this.#refreshViewers(room));
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Video) {
        useVoice.getState().patch({ rev: useVoice.getState().rev + 1 });
        const source = streamSourceOf(pub.source);
        if (source) this.#applyQuality(streamKey(participant.identity, source));
        return;
      }
      const stream = pub.source === Track.Source.ScreenShareAudio;
      const key = stream ? streamKey(participant.identity, "screen") : participant.identity;
      const el = track.attach();
      el.dataset.tincanVoice = key;
      el.style.display = "none";
      document.body.appendChild(el);
      if (track instanceof RemoteAudioTrack && this.#playback) this.#chain(track, key, this.#playback);
      const sink = useAudioPrefs.getState().prefs.outputDeviceId;
      if (sink) void room.switchActiveDevice("audiooutput", sink).catch(() => undefined);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      track.detach().forEach((el) => el.remove());
      if (track.kind === Track.Kind.Video) {
        useVoice.getState().patch({ rev: useVoice.getState().rev + 1 });
      } else if (pub.source === Track.Source.ScreenShareAudio) {
        const key = streamKey(participant.identity, "screen");
        this.#chains.delete(key);
        this.#debugTaps.delete(key);
      }
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const self = useSession.getState().user?.id;
      const local = self ? useVoice.getState().speaking[self] : undefined;
      const next: Record<string, boolean> = Object.fromEntries(speakers.map((s) => [s.identity, true]));
      // Our own ring comes from our own analyser on the published signal only: the server's list lags and would flip it.
      if (self) next[self] = local === true;
      useVoice.getState().patch({ speaking: next });
    });
    room.on(RoomEvent.ConnectionQualityChanged, (q, participant) => {
      useVoice.getState().patch({
        quality: { ...useVoice.getState().quality, [participant.identity]: QUALITY[q] ?? "unknown" },
      });
    });
    room.on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
      if (participant !== room.localParticipant) return;
      const perm = participant.permissions;
      const may = (source: number) =>
        !!perm?.canPublish &&
        (perm.canPublishSources.length === 0 || perm.canPublishSources.includes(source));
      const mayPublishMic = may(PROTOCOL_MICROPHONE);
      useVoice.getState().patch({ canCamera: may(PROTOCOL_CAMERA), canScreen: may(PROTOCOL_SCREEN_SHARE) });
      if (mayPublishMic) void this.#publishMic(room, useAudioPrefs.getState().prefs);
    });
    room.on(RoomEvent.EncryptionError, () => {
      const now = Date.now();
      this.#decryptErrors = [...this.#decryptErrors.filter((t) => now - t < 10_000), now];
      if (this.#decryptErrors.length >= 5 && useVoice.getState().e2ee !== "resyncing") void this.#resyncKey();
    });
    room.on(RoomEvent.Reconnecting, () => useVoice.getState().patch({ status: "reconnecting" }));
    room.on(RoomEvent.Reconnected, () => {
      useVoice.getState().patch({ status: "connected" });
      void this.#detectTransport(room);
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      if (this.#leaving) return;
      const notice: VoiceNotice =
        reason === DisconnectReason.DUPLICATE_IDENTITY
          ? "joined_elsewhere"
          : reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED
            ? "removed"
            : "disconnected";
      // When the server removed us it also tells us why over the gateway; give that message a moment to arrive.
      const wait = notice === "removed" ? new Promise((r) => setTimeout(r, 1500)) : Promise.resolve();
      void Promise.all([this.#teardown(), wait]).then(() => {
        useVoice.getState().patch({
          status: notice === "disconnected" ? "failed" : "idle",
          channelId: notice === "disconnected" ? useVoice.getState().channelId : null,
          notice: useVoice.getState().notice ?? notice,
          speaking: {},
          localLevel: 0,
        });
      });
    });
    room.on(RoomEvent.MediaDevicesError, () => useVoice.getState().patch({ notice: "mic_denied" }));
  }

  async #detectTransport(room: Room): Promise<void> {
    try {
      await new Promise((r) => setTimeout(r, 1500));
      if (room.state !== ConnectionState.Connected) return;
      const pc = room.engine.pcManager?.publisher ?? room.engine.pcManager?.subscriber;
      const report = await pc?.getStats();
      if (!report) return;
      const cands = new Map<string, RTCStats & Record<string, unknown>>();
      report.forEach((s: RTCStats & Record<string, unknown>) => {
        if (s.type === "local-candidate") cands.set(s.id, s);
      });
      report.forEach((s: RTCStats & Record<string, unknown>) => {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
          const l = cands.get(String(s.localCandidateId));
          const transport = l?.candidateType === "relay" ? "relay" : l?.protocol === "tcp" ? "tcp" : "udp";
          useVoice.getState().patch({ transport });
        }
      });
    } catch {
      // diagnostics only
    }
  }
}

const captureKey = (p: AudioPrefs) => ({
  d: p.inputDeviceId,
  p: p.preset,
  t: p.noiseTier,
  g: p.noiseGate,
  a: p.echoCancellation,
  c: p.autoGain,
});

const specInfo = (r: Resolved): SpecInfo => ({
  preset: r.preset.id,
  width: r.preset.width,
  height: r.preset.height,
  fps: r.preset.fps,
  kbps: r.kbps,
  wantedKbps: r.wantedKbps,
  uploadKbps: uploadKbps(r.preset),
  codec: r.codec,
  cappedByServer: r.cappedByServer,
});

/** Video state that belongs to one call. */
const VIDEO_RESET = {
  cameraOn: false,
  screenOn: false,
  cameraSpec: null,
  actual: { camera: null, screen: null },
  canCamera: false,
  canScreen: false,
  watching: {},
  streamQuality: {},
  streamMuted: {},
  viewers: {},
  share: null,
  watchNotice: null,
  rev: 0,
  e2ee: "off" as const,
  e2eeEpoch: null,
};

export const voiceManager = new VoiceManager();
