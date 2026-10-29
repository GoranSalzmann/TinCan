// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useVoice } from "../../core/voice/store.js";
import { DEFAULT_CUSTOM, useVideoPrefs } from "../../core/voice/video.js";
import { QualityControls } from "./QualityControls.js";

const reset = () =>
  useVideoPrefs.setState({
    prefs: {
      ...useVideoPrefs.getState().prefs,
      screenPreset: "standard",
      screenCustom: DEFAULT_CUSTOM.screen,
      cameraPreset: "standard",
      cameraCustom: DEFAULT_CUSTOM.camera,
    },
  });

beforeEach(() => {
  reset();
  useVoice.setState({ caps: { cameraKbps: 1700, screenKbps: 6000 } });
});
afterEach(() => {
  reset();
  useVoice.getState().reset();
});

describe("quality controls", () => {
  it("shows a preset's values in the controls", () => {
    render(<QualityControls source="screen" />);
    expect(screen.getByLabelText("Resolution")).toHaveValue("1080");
    expect(screen.getByLabelText("Frame rate")).toHaveValue("30");
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
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
});
