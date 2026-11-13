// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoice } from "../../core/voice/store.js";
import * as video from "../../core/voice/video.js";
import { DEFAULT_CUSTOM, useVideoPrefs, type CodecSupport } from "../../core/voice/video.js";
import { QualityControls } from "./QualityControls.js";

const prefsKey = "tincan.video.prefs.v1";
const initialPrefs = useVideoPrefs.getInitialState().prefs;
let support: CodecSupport;

const reset = () => {
  useVideoPrefs.setState({
    prefs: {
      ...initialPrefs,
      screenPreset: "standard",
      screenCustom: DEFAULT_CUSTOM.screen,
      screenCodec: "auto",
      cameraPreset: "standard",
      cameraCustom: DEFAULT_CUSTOM.camera,
      cameraCodec: "auto",
    },
  });
  localStorage.removeItem(prefsKey);
};

beforeEach(() => {
  reset();
  support = { h264: false, vp9: false, av1Hardware: false };
  vi.spyOn(video, "knownCodecSupport").mockImplementation(() => support);
  // Capability changes are completed explicitly in the tests that exercise detection.
  vi.spyOn(video, "detectCodecSupport").mockReturnValue(new Promise(() => {}));
  useVoice.setState({ caps: { cameraKbps: 1700, screenKbps: 6000 } });
});
afterEach(() => {
  vi.restoreAllMocks();
  reset();
  useVoice.getState().reset();
});

describe("quality controls", () => {
  it("shows a preset's values in the controls", () => {
    render(<QualityControls source="screen" />);
    expect(screen.getByLabelText("Resolution")).toHaveValue("1080");
    expect(screen.getByLabelText("Frame rate")).toHaveValue("30");
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
    expect(screen.getByText(/Codec to use: VP8/)).toBeInTheDocument();
  });

  it("switches to Custom, keeping the shown values, when a control is edited", () => {
    render(<QualityControls source="screen" />);
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "60" } });
    expect(screen.getByRole("radio", { name: "Custom" })).toBeChecked();
    expect(screen.getByLabelText("Resolution")).toHaveValue("1080");
    expect(useVideoPrefs.getState().prefs).toMatchObject({
      screenPreset: "custom",
      screenCustom: { height: 1080, fps: 60, bitrateKbps: null },
    });
    // Choosing a preset again fills the controls with its values and keeps the custom ones for later.
    fireEvent.click(screen.getByRole("radio", { name: /Low upload/ }));
    expect(screen.getByLabelText("Resolution")).toHaveValue("720");
    expect(screen.getByLabelText("Frame rate")).toHaveValue("15");
    expect(useVideoPrefs.getState().prefs.screenCustom.fps).toBe(60);
  });

  it("offers Auto for the bitrate by default and takes a manual value in Mbit/s", () => {
    render(<QualityControls source="screen" />);
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "1440" } });
    expect(screen.getByRole("radio", { name: /Auto for this resolution/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /Set a value/ }));
    fireEvent.change(screen.getByLabelText("Bitrate in megabits per second"), { target: { value: "4.5" } });
    expect(useVideoPrefs.getState().prefs.screenCustom).toMatchObject({ height: 1440, bitrateKbps: 4500 });
  });

  it("says plainly when the cap is too low, and offers the highest resolution that fits", () => {
    render(<QualityControls source="screen" />);
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "2160" } });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Capped to 6 Mbit/s by the server or channel, expect blockiness");
    fireEvent.click(screen.getByRole("button", { name: "Use 1080p at 30 fps" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Resolution")).toHaveValue("1080");
  });

  it("warns for 4K and 60 fps when the cap allows them", () => {
    useVoice.setState({ caps: { cameraKbps: 25_000, screenKbps: 60_000 } });
    render(<QualityControls source="screen" />);
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "2160" } });
    expect(screen.getByRole("note")).toHaveTextContent("needs a fast computer");
  });

  it("greys out presets above the cap and works for the camera too", () => {
    useVoice.setState({ caps: { cameraKbps: 1000, screenKbps: 6000 } });
    render(<QualityControls source="camera" />);
    expect(screen.getByRole("radio", { name: /High/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "5" } });
    expect(useVideoPrefs.getState().prefs.cameraPreset).toBe("custom");
  });

  it("offers an accessible native codec selection and explains local saving and the AV1 limit", () => {
    render(<QualityControls source="screen" />);
    const codec = screen.getByRole("combobox", { name: "Video codec" });
    expect(codec).toHaveValue("auto");
    expect(
      within(codec)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Auto", "VP8", "H.264", "VP9", "AV1"]);
    expect(within(codec).getByRole("option", { name: "H.264" })).toBeEnabled();
    expect(within(codec).getByRole("option", { name: "VP9" })).toBeEnabled();
    expect(within(codec).getByRole("option", { name: "AV1" })).toBeDisabled();
    expect(codec).toHaveAccessibleDescription(/Saved immediately in this browser/);
    expect(codec).toHaveAccessibleDescription(/AV1 is available only.*reports power-efficient encoding/);
  });

  it.each(["camera", "screen"] as const)(
    "persists the %s codec immediately, calls back with the previous preferences, and keeps it across presets and remounts",
    (source) => {
      support.h264 = true;
      const codecKey = source === "camera" ? "cameraCodec" : "screenCodec";
      const presetKey = source === "camera" ? "cameraPreset" : "screenPreset";
      const otherCodecKey = source === "camera" ? "screenCodec" : "cameraCodec";
      const prev = useVideoPrefs.getState().prefs;
      const onChanged = vi.fn();
      const { unmount } = render(<QualityControls source={source} onChanged={onChanged} />);

      fireEvent.change(screen.getByRole("combobox", { name: "Video codec" }), { target: { value: "h264" } });

      expect(useVideoPrefs.getState().prefs).toMatchObject({
        [codecKey]: "h264",
        [otherCodecKey]: "auto",
        [presetKey]: "standard",
        cameraCustom: DEFAULT_CUSTOM.camera,
        screenCustom: DEFAULT_CUSTOM.screen,
      });
      expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
      expect(screen.getByText(/Codec to use: H\.264/)).toBeInTheDocument();
      expect(onChanged).toHaveBeenCalledExactlyOnceWith(prev);
      expect(onChanged.mock.calls[0]![0]).toBe(prev);
      expect(prev[codecKey]).toBe("auto");
      expect(JSON.parse(localStorage.getItem(prefsKey)!)).toMatchObject({
        [codecKey]: "h264",
        [otherCodecKey]: "auto",
      });

      const beforePreset = useVideoPrefs.getState().prefs;
      fireEvent.click(screen.getByRole("radio", { name: /^Low/ }));
      expect(onChanged).toHaveBeenNthCalledWith(2, beforePreset);
      expect(useVideoPrefs.getState().prefs[codecKey]).toBe("h264");
      expect(useVideoPrefs.getState().prefs[presetKey]).toBe("low");
      expect(JSON.parse(localStorage.getItem(prefsKey)!)).toMatchObject({
        [codecKey]: "h264",
        [presetKey]: "low",
      });

      unmount();
      render(<QualityControls source={source} />);
      expect(screen.getByRole("combobox", { name: "Video codec" })).toHaveValue("h264");
      expect(screen.getByRole("radio", { name: /^Low/ })).toBeChecked();
    },
  );

  it("keeps camera and screen codec selections separate", () => {
    support.h264 = true;
    support.vp9 = true;
    const camera = render(<QualityControls source="camera" />);
    const share = render(<QualityControls source="screen" />);
    const cameraCodec = within(camera.container).getByRole("combobox", { name: "Video codec" });
    const screenCodec = within(share.container).getByRole("combobox", { name: "Video codec" });

    fireEvent.change(cameraCodec, { target: { value: "h264" } });
    expect(screenCodec).toHaveValue("auto");
    fireEvent.change(screenCodec, { target: { value: "vp9" } });
    expect(cameraCodec).toHaveValue("h264");
    expect(screenCodec).toHaveValue("vp9");
    expect(JSON.parse(localStorage.getItem(prefsKey)!)).toMatchObject({
      cameraCodec: "h264",
      screenCodec: "vp9",
    });
  });

  it.each(["h264", "vp9", "av1"] as const)(
    "preserves an unsupported saved %s preference and explains the codec fallback",
    (codec) => {
      useVideoPrefs.getState().set({ screenCodec: codec });
      const saved = localStorage.getItem(prefsKey);
      const onChanged = vi.fn();
      render(<QualityControls source="screen" onChanged={onChanged} />);

      expect(screen.getByRole("combobox", { name: "Video codec" })).toHaveValue(codec);
      expect(screen.getByRole("status")).toHaveTextContent(
        /VP8 will be used instead; your preference stays saved/,
      );
      expect(screen.getByText(/Codec to use: VP8/)).toBeInTheDocument();
      expect(useVideoPrefs.getState().prefs.screenCodec).toBe(codec);
      expect(localStorage.getItem(prefsKey)).toBe(saved);
      expect(onChanged).not.toHaveBeenCalled();
    },
  );

  it("keeps the saved preference when capability detection finishes and updates only the codec to use", async () => {
    useVideoPrefs.getState().set({ screenCodec: "vp9" });
    const saved = localStorage.getItem(prefsKey);
    const onChanged = vi.fn();
    let complete!: (support: CodecSupport) => void;
    vi.mocked(video.detectCodecSupport).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    render(<QualityControls source="screen" onChanged={onChanged} />);
    expect(screen.getByText(/Codec to use: VP8/)).toBeInTheDocument();

    await act(async () => {
      support = { ...support, vp9: true };
      complete(support);
    });

    expect(screen.getByRole("combobox", { name: "Video codec" })).toHaveValue("vp9");
    expect(screen.getByText(/Codec to use: VP9/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(useVideoPrefs.getState().prefs.screenCodec).toBe("vp9");
    expect(localStorage.getItem(prefsKey)).toBe(saved);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("allows AV1 when the browser reports power-efficient encoding", () => {
    support.av1Hardware = true;
    render(<QualityControls source="screen" />);
    expect(screen.getByRole("option", { name: "AV1" })).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Video codec" }), { target: { value: "av1" } });
    expect(useVideoPrefs.getState().prefs.screenCodec).toBe("av1");
    expect(screen.getByText(/Codec to use: AV1/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
  });

  it("uses the selected codec for custom automatic bitrate and upload estimates", () => {
    support.vp9 = true;
    useVoice.setState({ caps: { cameraKbps: 1700, screenKbps: 5500 } });
    render(<QualityControls source="screen" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Video codec" }), { target: { value: "vp8" } });
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "1440" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Capped to 5.5 Mbit/s");

    fireEvent.change(screen.getByRole("combobox", { name: "Video codec" }), { target: { value: "vp9" } });

    const resolved = video.resolveVideo(
      "screen",
      "custom",
      { ...DEFAULT_CUSTOM.screen, height: 1440 },
      5500,
      support,
      "vp9",
    )!;
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("radio", { name: /Auto for this resolution/ })).toHaveAccessibleName(
      `Auto for this resolution and frame rate (about ${resolved.wantedKbps / 1000} Mbit/s)`,
    );
    expect(screen.getByText(/About .* Mbps up/)).toHaveTextContent(
      `About ${video.uploadKbps(resolved.preset) / 1000} Mbps up`,
    );
    expect(screen.getByText(/Codec to use: VP9/)).toBeInTheDocument();
  });
});
