// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "../../core/voice/actions.js";
import { useVoice } from "../../core/voice/store.js";
import * as video from "../../core/voice/video.js";
import { ShareDialog } from "./ShareDialog.js";

const prefsKey = "tincan.video.prefs.v1";
const initialPrefs = video.useVideoPrefs.getInitialState().prefs;
const nextStartNote = /Codec changes are saved for your next screen share/;

const reset = () => {
  useVoice.getState().reset();
  video.useVideoPrefs.setState({
    prefs: {
      ...initialPrefs,
      screenPreset: "standard",
      screenCustom: video.DEFAULT_CUSTOM.screen,
      screenCodec: "auto",
      contentHint: "detail",
      shareAudio: true,
    },
  });
  localStorage.removeItem(prefsKey);
};

beforeEach(() => {
  reset();
  vi.spyOn(actions, "startScreenShare").mockResolvedValue(undefined);
  vi.spyOn(actions, "updateScreenShare").mockResolvedValue(undefined);
  vi.spyOn(video, "knownCodecSupport").mockReturnValue({
    h264: true,
    vp9: true,
    av1Hardware: false,
  });
  vi.spyOn(video, "detectCodecSupport").mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

describe("share dialog", () => {
  it("explains that codec edits apply next time and updates a running share on Apply without starting one", async () => {
    useVoice.setState({
      screenOn: true,
      share: { preset: "standard", hint: "detail", audio: false, surface: "monitor", spec: null },
    });
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} />);

    expect(screen.getByRole("dialog", { name: "Change stream settings" })).toBeInTheDocument();
    expect(screen.getByText(nextStartNote)).toHaveTextContent(
      "The current stream keeps its codec until you stop sharing and start again.",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Video codec" }), { target: { value: "h264" } });
    expect(video.useVideoPrefs.getState().prefs.screenCodec).toBe("h264");
    expect(actions.updateScreenShare).not.toHaveBeenCalled();
    expect(actions.startScreenShare).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    });

    expect(actions.updateScreenShare).toHaveBeenCalledExactlyOnceWith({ hint: "detail" });
    expect(actions.startScreenShare).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not show the next-start note for a new share and starts it on Continue", async () => {
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} />);

    expect(screen.getByRole("dialog", { name: "Share your screen" })).toBeInTheDocument();
    expect(screen.queryByText(nextStartNote)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });

    expect(actions.startScreenShare).toHaveBeenCalledExactlyOnceWith({ hint: "detail", audio: true });
    expect(actions.updateScreenShare).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});
