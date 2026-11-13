// SPDX-License-Identifier: AGPL-3.0-or-later
/* eslint-disable @typescript-eslint/unbound-method -- LiveKit methods below are mocked and inspected, not called unbound. */
import type * as Livekit from "livekit-client";
import {
  Track,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
} from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishOptionsFor, voiceManager } from "./manager.js";
import { useVoice } from "./store.js";
import type * as Video from "./video.js";
import {
  autoKbps,
  DEFAULT_CUSTOM,
  detectCodecSupport,
  resolveVideo,
  uploadKbps,
  useVideoPrefs,
  type StreamSource,
  type VideoCodecName,
  type VideoCodecPreference,
} from "./video.js";

vi.mock("../api/client.js", () => ({
  request: vi.fn(async () => ({
    url: "wss://voice.test",
    token: "token",
    publishDefaults: {
      sources: ["camera", "screen_share"],
      audioBitrateKbps: 40,
      video: { cameraMaxKbps: 60_000, screenshareMaxKbps: 60_000 },
    },
  })),
}));
vi.mock("../session/store.js", () => ({
  sendCommand: vi.fn(),
  useSession: { getState: () => ({ user: null }) },
}));
vi.mock("../sfx/sfx.js", () => ({ playSfx: vi.fn() }));
vi.mock("./pipeline.js", () => ({ createPipeline: vi.fn() }));
vi.mock("./video.js", async (original) => ({
  ...(await original<typeof Video>()),
  detectCodecSupport: vi.fn(async () => ({ h264: true, vp9: true, av1Hardware: true })),
}));
vi.mock("livekit-client", async (original) => {
  const livekit = await original<typeof Livekit>();
  const makeTrack = (options?: TrackPublishOptions) => {
    const layers = options?.videoSimulcastLayers ?? options?.screenShareSimulcastLayers ?? [];
    const params = {
      encodings: Array.from({ length: options?.simulcast ? layers.length + 1 : 1 }, () => ({
        maxBitrate: 0,
      })),
    };
    return {
      codec: options?.videoCodec,
      mediaStreamTrack: {
        contentHint: "",
        getSettings: () => ({ width: 1920, height: 1080, frameRate: 30, displaySurface: "window" }),
        applyConstraints: vi.fn(async (_constraints: MediaTrackConstraints) => undefined),
      },
      sender: {
        getParameters: vi.fn(() => params),
        setParameters: vi.fn(async (_params: RTCRtpSendParameters) => undefined),
      },
      getSenderStats: vi.fn(async () => []),
      stop: vi.fn(),
    };
  };
  return {
    ...livekit,
    Room: class {
      state = livekit.ConnectionState.Connected;
      engine = {};
      remoteParticipants = new Map();
      publications = new Map<
        Track.Source,
        { track: ReturnType<typeof makeTrack>; videoTrack: ReturnType<typeof makeTrack> }
      >();
      localParticipant = {
        identity: "self",
        attributes: {},
        getTrackPublication: (source: Track.Source) => this.publications.get(source),
        setCameraEnabled: vi.fn(
          async (on: boolean, _capture?: VideoCaptureOptions, options?: TrackPublishOptions) => {
            this.setVideo(livekit.Track.Source.Camera, on, options);
          },
        ),
        setScreenShareEnabled: vi.fn(
          async (on: boolean, _capture?: ScreenShareCaptureOptions, options?: TrackPublishOptions) => {
            this.setVideo(livekit.Track.Source.ScreenShare, on, options);
          },
        ),
        unpublishTrack: vi.fn(async (track: ReturnType<typeof makeTrack>, stop: boolean) => {
          for (const [source, pub] of this.publications) {
            if (pub.track !== track) continue;
            this.publications.delete(source);
            if (stop) track.stop();
          }
        }),
      };
      setVideo(source: Track.Source, on: boolean, options?: TrackPublishOptions) {
        if (!on) return void this.publications.delete(source);
        const track = makeTrack(options);
        this.publications.set(source, { track, videoTrack: track });
      }
      on() {
        return this;
      }
      connect = vi.fn(async () => undefined);
      disconnect = vi.fn(async () => undefined);
      removeAllListeners = vi.fn();
      switchActiveDevice = vi.fn(async () => undefined);
    },
  };
});

const CODECS: VideoCodecName[] = ["vp8", "h264", "vp9", "av1"];
const SUPPORT = { h264: true, vp9: true, av1Hardware: true };
const initialPrefs = useVideoPrefs.getState().prefs;
const isSvc = (codec: VideoCodecName) => codec === "vp9" || codec === "av1";

describe("video publish options", () => {
  for (const source of ["camera", "screen"] as const) {
    it.each(CODECS)(`${source}: requests %s explicitly with the appropriate encoding and layers`, (codec) => {
      const r = resolveVideo(source, "standard", DEFAULT_CUSTOM[source], 60_000, SUPPORT, codec)!;
      const options = publishOptionsFor(source, r);
      const encoding = source === "camera" ? options.videoEncoding : options.screenShareEncoding;
      const layers = source === "camera" ? options.videoSimulcastLayers : options.screenShareSimulcastLayers;
      expect(options.videoCodec).toBe(codec);
      expect(encoding).toEqual({ maxBitrate: r.kbps * 1000, maxFramerate: r.preset.fps });
      expect(options.simulcast).toBe(!isSvc(codec));
      expect(
        layers?.map((layer) => ({
          width: layer.width,
          height: layer.height,
          kbps: layer.encoding.maxBitrate / 1000,
          fps: layer.encoding.maxFramerate,
        })),
      ).toEqual(r.preset.layers);
      // The SDK chooses the source-appropriate SVC mode; never apply one to VP8/H264.
      expect(options.scalabilityMode).toBeUndefined();
      if (isSvc(codec)) expect(layers).toEqual([]);
    });
  }

  it.each(["vp8", "h264"] as const)("does not enable simulcast for a single-layer %s share", (codec) => {
    const r = resolveVideo("screen", "low", DEFAULT_CUSTOM.screen, 60_000, SUPPORT, codec)!;
    expect(publishOptionsFor("screen", r)).toMatchObject({
      videoCodec: codec,
      simulcast: false,
      screenShareSimulcastLayers: [],
    });
  });

  it("keeps screen audio stereo, without DTX or RED, independently of the video codec", () => {
    const r = resolveVideo("screen", "standard", DEFAULT_CUSTOM.screen, 60_000, SUPPORT, "h264")!;
    expect(publishOptionsFor("screen", r)).toMatchObject({
      forceStereo: true,
      dtx: false,
      red: false,
      audioPreset: { maxBitrate: 96_000 },
    });
  });
});

describe("saved codec preferences in the voice manager", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(detectCodecSupport).mockResolvedValue(SUPPORT);
    vi.stubGlobal(
      "AudioContext",
      class {
        resume = vi.fn(async () => undefined);
        close = vi.fn(async () => undefined);
      },
    );
    useVoice.getState().reset();
    useVideoPrefs.setState({ prefs: { ...initialPrefs, cameraCodec: "auto", screenCodec: "auto" } });
    await voiceManager.join("channel");
  });

  afterEach(async () => {
    await voiceManager.leave({ silent: true });
    // Let the existing actual-stats poll observe that no video is published and stop itself.
    await vi.advanceTimersByTimeAsync(2000);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useVideoPrefs.setState({ prefs: initialPrefs });
    localStorage.clear();
    useVoice.getState().reset();
  });

  it.each(CODECS)(
    "publishes the camera with its saved %s preference, not the screen preference",
    async (codec) => {
      useVideoPrefs.getState().set({ cameraCodec: codec, screenCodec: codec === "vp8" ? "av1" : "vp8" });
      await voiceManager.setCamera(true);
      const participant = voiceManager.room!.localParticipant;
      expect(participant.setCameraEnabled).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ resolution: { width: 1280, height: 720, frameRate: 30 } }),
        expect.objectContaining({ videoCodec: codec, simulcast: !isSvc(codec) }),
      );
      expect(useVoice.getState()).toMatchObject({ cameraOn: true, cameraSpec: { codec }, notice: null });
    },
  );

  it.each(CODECS)("starts a share with its saved %s preference, not the camera preference", async (codec) => {
    useVideoPrefs.getState().set({ cameraCodec: codec === "vp8" ? "av1" : "vp8", screenCodec: codec });
    await voiceManager.startScreenShare({ hint: "detail", audio: false });
    expect(voiceManager.room!.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ audio: false, contentHint: "detail" }),
      expect.objectContaining({ videoCodec: codec, simulcast: !isSvc(codec) }),
    );
    expect(useVoice.getState()).toMatchObject({
      screenOn: true,
      share: { spec: { codec }, surface: "window", hint: "detail" },
    });
  });

  it.each([
    ["vp8", "h264"],
    ["auto", "vp8"],
  ] satisfies [VideoCodecPreference, VideoCodecPreference][])(
    "stops and republishes an enabled camera when its preference changes from %s to %s",
    async (from, to) => {
      useVideoPrefs.getState().set({ cameraCodec: from });
      await voiceManager.setCamera(true);
      const prev = useVideoPrefs.getState().prefs;
      const participant = voiceManager.room!.localParticipant;
      const oldTrack = participant.getTrackPublication(Track.Source.Camera)!.track;
      useVideoPrefs.getState().set({ cameraCodec: to });
      await voiceManager.applyCameraPrefs(prev);
      expect(participant.unpublishTrack).toHaveBeenCalledWith(oldTrack, true);
      expect(oldTrack!.stop).toHaveBeenCalledOnce();
      expect(participant.setCameraEnabled).toHaveBeenCalledTimes(2);
      expect(participant.setCameraEnabled).toHaveBeenLastCalledWith(
        true,
        expect.anything(),
        expect.objectContaining({ videoCodec: to }),
      );
      expect(useVoice.getState()).toMatchObject({ cameraOn: true, cameraSpec: { codec: to } });
    },
  );

  it("does not start a disabled camera just because its codec preference changed", async () => {
    const prev = useVideoPrefs.getState().prefs;
    useVideoPrefs.getState().set({ cameraCodec: "h264" });
    await voiceManager.applyCameraPrefs(prev);
    expect(voiceManager.room!.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(useVoice.getState().cameraOn).toBe(false);
  });

  it("does not republish the camera for screen-only changes and still switches camera devices in place", async () => {
    await voiceManager.setCamera(true);
    const prev = useVideoPrefs.getState().prefs;
    useVideoPrefs.getState().set({ screenCodec: "h264", cameraDeviceId: "other-camera" });
    await voiceManager.applyCameraPrefs(prev);
    expect(voiceManager.room!.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(voiceManager.room!.localParticipant.setCameraEnabled).toHaveBeenCalledOnce();
    expect(voiceManager.room!.switchActiveDevice).toHaveBeenCalledWith("videoinput", "other-camera");
  });

  it.each(CODECS)(
    "keeps a running %s share across preference, custom-quality and preset changes",
    async (codec) => {
      useVideoPrefs.getState().set({ screenCodec: codec });
      await voiceManager.startScreenShare({ hint: "detail", audio: false });
      const participant = voiceManager.room!.localParticipant;
      const track = participant.getTrackPublication(Track.Source.ScreenShare)!.videoTrack!;
      const preference = codec === "av1" ? "vp8" : "av1";
      const custom = { height: 2160, fps: 60, bitrateKbps: null };
      useVideoPrefs.getState().set({ screenCodec: preference, screenPreset: "custom", screenCustom: custom });
      // A running encoder remains fixed even if a later capability result would not offer it.
      vi.mocked(detectCodecSupport).mockResolvedValue({ h264: false, vp9: false, av1Hardware: false });
      await voiceManager.updateScreenShare({ hint: "motion" });
      const expected = resolveVideo("screen", "custom", custom, 60_000, SUPPORT, preference, codec)!;
      expect(track.mediaStreamTrack.applyConstraints).toHaveBeenLastCalledWith({
        frameRate: 60,
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      });
      expect(useVoice.getState().share).toMatchObject({
        hint: "motion",
        spec: { codec, kbps: expected.kbps, uploadKbps: uploadKbps(expected.preset) },
      });
      expect(track.sender!.getParameters().encodings.at(-1)!.maxBitrate).toBe(expected.kbps * 1000);
      if (!isSvc(codec)) {
        const half = expected.preset.layers.find((layer) => layer.height === 1080)!;
        expect(track.sender!.getParameters().encodings[0]!.maxBitrate).toBe(half.kbps * 1000);
      }
      useVideoPrefs.getState().set({ screenPreset: "standard" });
      await voiceManager.updateScreenShare({ hint: "detail" });
      const preset = resolveVideo("screen", "standard", custom, 60_000, SUPPORT, preference, codec)!;
      expect(useVoice.getState().share?.spec).toMatchObject({
        codec,
        preset: "standard",
        uploadKbps: uploadKbps(preset.preset),
      });
      expect(participant.setScreenShareEnabled).toHaveBeenCalledOnce();
      expect(track.codec).toBe(codec);
    },
  );

  it("uses LiveKit's selected fallback for live bitrates, while the spec codec remains the request", async () => {
    useVideoPrefs.getState().set({ screenCodec: "vp9" });
    await voiceManager.startScreenShare({ hint: "detail", audio: false });
    const track = voiceManager.room!.localParticipant.getTrackPublication(
      Track.Source.ScreenShare,
    )!.videoTrack!;
    track.codec = "h264"; // The SDK/server may select a different codec during publication.
    track.sender!.getParameters().encodings[0]!.scaleResolutionDownBy = 2;
    useVideoPrefs.getState().set({
      screenCodec: "av1",
      screenPreset: "custom",
      screenCustom: { height: 1440, fps: 30, bitrateKbps: null },
    });
    await voiceManager.updateScreenShare({ hint: "motion" });
    const kbps = autoKbps(2560, 1440, 30, "h264");
    expect(useVoice.getState().share?.spec).toMatchObject({ codec: "vp9", kbps, wantedKbps: kbps });
    // A single sender still gets the top bitrate, not the new preset's lowest simulcast-layer bitrate.
    expect(track.sender!.getParameters().encodings).toEqual([
      { maxBitrate: kbps * 1000, scaleResolutionDownBy: 2 },
    ]);
    expect(track.codec).toBe("h264");
    expect(useVideoPrefs.getState().prefs.screenCodec).toBe("av1");
  });

  for (const codec of ["vp8", "h264"] as const) {
    it.each([
      {
        name: "SDK scales",
        scales: [4, 2, 1],
        standard: [150_000, 600_000, 3_500_000],
        low: [62_500, 250_000, 1_000_000],
      },
      {
        name: "non-default SDK scales",
        scales: [8, 2, 1],
        standard: [37_500, 600_000, 3_500_000],
        low: [15_625, 250_000, 1_000_000],
      },
      {
        name: "inferred scales",
        scales: null,
        standard: [150_000, 600_000, 3_500_000],
        low: [62_500, 250_000, 1_000_000],
      },
    ])(`keeps all ${codec} encodings sensibly capped when downsizing 4K with $name`, async (test) => {
      useVideoPrefs.getState().set({
        screenCodec: codec,
        screenPreset: "custom",
        screenCustom: { height: 2160, fps: 60, bitrateKbps: null },
      });
      await voiceManager.startScreenShare({ hint: "detail", audio: false });
      const participant = voiceManager.room!.localParticipant;
      const sender = participant.getTrackPublication(Track.Source.ScreenShare)!.videoTrack!.sender!;
      const params = sender.getParameters();
      expect(params.encodings).toHaveLength(3);
      if (test.scales) {
        params.encodings.forEach((encoding, i) => {
          encoding.scaleResolutionDownBy = test.scales[i];
        });
      }
      for (const preset of ["standard", "low"] as const) {
        useVideoPrefs.getState().set({ screenPreset: preset });
        await voiceManager.updateScreenShare({ hint: "detail" });
        expect(params.encodings.map((encoding) => encoding.maxBitrate)).toEqual(test[preset]);
        expect(params.encodings.map((encoding) => encoding.scaleResolutionDownBy)).toEqual(
          test.scales ?? [undefined, undefined, undefined],
        );
        expect(sender.setParameters).toHaveBeenLastCalledWith(params);
      }
      expect(participant.setScreenShareEnabled).toHaveBeenCalledOnce();
    });
  }

  it.each(CODECS)(
    "keeps the original %s request if LiveKit has not exposed a selected codec",
    async (codec) => {
      useVideoPrefs.getState().set({ screenCodec: codec });
      await voiceManager.startScreenShare({ hint: "detail", audio: false });
      const track = voiceManager.room!.localParticipant.getTrackPublication(
        Track.Source.ScreenShare,
      )!.videoTrack!;
      track.codec = undefined;
      useVideoPrefs.getState().set({ screenCodec: codec === "vp8" ? "av1" : "vp8" });
      await voiceManager.updateScreenShare({ hint: "motion" });
      expect(useVoice.getState().share?.spec?.codec).toBe(codec);
    },
  );

  it("uses a changed screen codec preference only after stopping and starting the share", async () => {
    useVideoPrefs.getState().set({ screenCodec: "h264" });
    await voiceManager.startScreenShare({ hint: "detail", audio: false });
    useVideoPrefs.getState().set({ screenCodec: "vp9" });
    await voiceManager.updateScreenShare({ hint: "motion" });
    expect(useVoice.getState().share?.spec?.codec).toBe("h264");
    await voiceManager.stopScreenShare();
    expect(useVoice.getState()).toMatchObject({ screenOn: false, share: null });
    await voiceManager.startScreenShare({ hint: "motion", audio: false });
    expect(voiceManager.room!.localParticipant.setScreenShareEnabled).toHaveBeenLastCalledWith(
      true,
      expect.anything(),
      expect.objectContaining({ videoCodec: "vp9" }),
    );
    expect(useVoice.getState().share?.spec?.codec).toBe("vp9");
  });

  it.each(["camera", "screen"] satisfies StreamSource[])(
    "requests VP8 for an unavailable saved %s codec without changing that preference",
    async (source) => {
      vi.mocked(detectCodecSupport).mockResolvedValue({ h264: false, vp9: false, av1Hardware: false });
      useVideoPrefs.getState().set({ cameraCodec: "h264", screenCodec: "av1" });
      if (source === "camera") await voiceManager.setCamera(true);
      else await voiceManager.startScreenShare({ hint: "detail", audio: false });
      const participant = voiceManager.room!.localParticipant;
      const publish = source === "camera" ? participant.setCameraEnabled : participant.setScreenShareEnabled;
      expect(publish).toHaveBeenLastCalledWith(
        true,
        expect.anything(),
        expect.objectContaining({ videoCodec: "vp8" }),
      );
      expect(useVideoPrefs.getState().prefs).toMatchObject({ cameraCodec: "h264", screenCodec: "av1" });
    },
  );
});
