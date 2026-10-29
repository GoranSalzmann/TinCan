// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteTrackPublication,
} from "livekit-client";
import { request } from "../api/client.js";
import { sendCommand, useSession } from "../session/store.js";
import { createPipeline, type Pipeline } from "./pipeline.js";
import { effectiveSettings, useAudioPrefs, type AudioPrefs } from "./prefs.js";
import { useVoice, type Quality, type VoiceNotice } from "./store.js";
import { autoThreshold, PushToTalk, rms, VoiceActivity } from "./transmit.js";
import type { VoiceJoinResponse } from "@tincan/shared";

/** `TrackSource.MICROPHONE` in LiveKit's protocol enum, which livekit-client does not re-export. */
const PROTOCOL_MICROPHONE = 2;
const VOLUME_KEY = "tincan.voice.volumes.v1";

function loadVolumes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
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
  #cleanups: (() => void)[] = [];

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
    });
    this.#leaving = false;

    const grant = await request<VoiceJoinResponse>(
      "POST",
      `/voice/channels/${encodeURIComponent(channelId)}/join`,
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
    const room = new Room({
      adaptiveStream: false,
      dynacast: true,
      stopLocalTrackOnUnpublish: false,
      publishDefaults: { dtx: settings.dtx, red: settings.dtx },
    });
    this.#room = room;
    this.#wire(room);

    try {
      await room.connect(grant.url, grant.token, { autoSubscribe: false });
    } catch (err) {
      await this.#teardown();
      throw err;
    }
    for (const p of room.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) this.#subscribeIfAudio(pub);

    this.#capKbps = grant.publishDefaults.audioBitrateKbps;
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
    });
    if (had && !o.silent) void request("POST", "/voice/leave").catch(() => undefined);
    if (had && o.silent) void request("POST", "/voice/leave").catch(() => undefined);
  }

  async #teardown(): Promise<void> {
    this.#unsubPrefs?.();
    this.#unsubPrefs = null;
    if (this.#meter) clearInterval(this.#meter);
    this.#meter = null;
    for (const c of this.#cleanups.splice(0)) c();
    this.#ptt?.reset();
    this.#ptt = null;
    const room = this.#room;
    this.#room = null;
    this.#local = null;
    this.#pipeline?.stop();
    this.#pipeline = null;
    if (room) {
      room.removeAllListeners();
      await room.disconnect().catch(() => undefined);
    }
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
          if (pub.kind === Track.Kind.Audio) void pub.setSubscribed(!deafened);
        }
      }
    }
    this.#applyTransmit();
    this.#announceSelf();
  }

  setUserVolume(userId: string, volume: number): void {
    this.#volumes[userId] = volume;
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(this.#volumes));
    } catch {
      // not persisted
    }
    this.#room?.remoteParticipants.get(userId)?.setVolume(volume);
  }

  volumeOf(userId: string): number {
    return this.#volumes[userId] ?? 1;
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
    const buf = new Float32Array(pipeline.analyser.fftSize);
    let floor = 0.02;
    let vad: VoiceActivity | null = null;
    let vadFor: number | null | undefined;
    this.#meter = setInterval(() => {
      pipeline.analyser.getFloatTimeDomainData(buf);
      const level = Math.min(1, rms(buf) * 4);
      floor = Math.min(floor * 1.002 + 0.00001, Math.max(0.005, level)); // slowly rising minimum
      const prefs = useAudioPrefs.getState().prefs;
      if (!vad || vadFor !== prefs.vadThreshold) {
        vad = new VoiceActivity(prefs.vadThreshold ?? autoThreshold(floor));
        vadFor = prefs.vadThreshold;
      }
      const s = useVoice.getState();
      const sending = !s.muted && (prefs.transmitMode === "vad" || s.transmitting);
      const speaking = sending && vad.update(level, Date.now());
      if (s.speaking[self] !== speaking || Math.abs(s.localLevel - level) > 0.02) {
        useVoice.getState().patch({ localLevel: level, speaking: { ...s.speaking, [self]: speaking } });
      }
    }, 80);
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

  #subscribeIfAudio(pub: RemoteTrackPublication): void {
    if (pub.kind === Track.Kind.Audio && !useVoice.getState().deafened) void pub.setSubscribed(true);
  }

  #wire(room: Room): void {
    // Audio is subscribed as soon as it is published; video will wait for "Watch" in M4 (08 §4.2).
    room.on(RoomEvent.TrackPublished, (pub) => this.#subscribeIfAudio(pub));
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.dataset.tincanVoice = participant.identity;
      el.style.display = "none";
      document.body.appendChild(el);
      participant.setVolume(this.volumeOf(participant.identity));
      const sink = useAudioPrefs.getState().prefs.outputDeviceId;
      if (sink) void room.switchActiveDevice("audiooutput", sink).catch(() => undefined);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const self = useSession.getState().user?.id;
      const local = self ? useVoice.getState().speaking[self] : undefined;
      const next: Record<string, boolean> = Object.fromEntries(speakers.map((s) => [s.identity, true]));
      if (self && local) next[self] = true; // the local indicator is immediate; the server's follows (08 §6)
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
      const mayPublishMic =
        !!perm?.canPublish &&
        (perm.canPublishSources.length === 0 || perm.canPublishSources.includes(PROTOCOL_MICROPHONE));
      if (mayPublishMic) void this.#publishMic(room, useAudioPrefs.getState().prefs);
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

export const voiceManager = new VoiceManager();
