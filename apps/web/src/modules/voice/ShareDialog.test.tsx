// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "../../core/voice/actions.js";
import * as helper from "../../core/voice/audio-helper.js";
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
  vi.spyOn(actions, "startScreenShare").mockResolvedValue(true);
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
  it("keeps the dialog open when the browser screen picker is cancelled", async () => {
    vi.mocked(actions.startScreenShare).mockResolvedValue(false);
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("requires an application selection and passes exact stream IDs to the manager", async () => {
    vi.spyOn(helper, "isLinuxDesktop").mockReturnValue(true);
    vi.spyOn(helper, "helperPreferred").mockReturnValue(true);
    vi.spyOn(helper, "supportsHelperAudio").mockReturnValue(true);
    vi.spyOn(helper, "hasHelperToken").mockReturnValue(true);
    vi.spyOn(helper, "checkHelper").mockResolvedValue();
    vi.spyOn(helper, "helperSources").mockResolvedValue([
      { id: "123", name: "Game", detail: "", running: true },
    ]);
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    const game = await screen.findByRole("checkbox", { name: /Game/ });
    fireEvent.click(game);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    vi.mocked(actions.startScreenShare).mockRejectedValue(new helper.HelperError("source_missing"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(actions.startScreenShare).toHaveBeenCalledWith({
      hint: "detail",
      audio: true,
      helper: { sources: ["123"], names: ["Game"] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/selected stream closed/i);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps polling the audio helper through transient failures", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(helper, "isLinuxDesktop").mockReturnValue(true);
      vi.spyOn(helper, "helperPreferred").mockReturnValue(true);
      vi.spyOn(helper, "supportsHelperAudio").mockReturnValue(true);
      vi.spyOn(helper, "hasHelperToken").mockReturnValue(true);
      vi.spyOn(helper, "checkHelper").mockResolvedValue();
      const list = vi
        .spyOn(helper, "helperSources")
        .mockResolvedValue([{ id: "1", name: "Game", detail: "", running: true }]);
      render(<ShareDialog open onOpenChange={vi.fn()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("checkbox", { name: /Game/ })).toBeInTheDocument();

      // A transient failure keeps the picker ready and polling in the background.
      list.mockRejectedValueOnce(new helper.HelperError("unavailable"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByRole("checkbox", { name: /Game/ })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();

      // The next poll recovers and resets the failure count.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(list).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("checkbox", { name: /Game/ })).toBeInTheDocument();

      // Three consecutive failures go offline and stop polling.
      list.mockRejectedValue(new helper.HelperError("unavailable"));
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(screen.queryByRole("checkbox", { name: /Game/ })).toBeNull();
      expect(screen.getByRole("alert")).toHaveTextContent(/reach the audio helper/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the user cancel a pending share and ignores its late completion", async () => {
    let finish: (started: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    vi.mocked(actions.startScreenShare).mockReturnValue(pending);
    const stop = vi.spyOn(actions, "stopScreenShare").mockResolvedValue();
    const onOpenChange = vi.fn();
    render(<ShareDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    await act(async () => {
      finish(true);
    });
    expect(onOpenChange).toHaveBeenCalledOnce();
  });

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
