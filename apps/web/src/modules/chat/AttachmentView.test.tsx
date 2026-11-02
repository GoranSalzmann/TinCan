// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "@tincan/shared";
import { AttachmentView } from "./AttachmentView.js";
import { ANIMATION_AUTOPLAY_MAX_BYTES, claimPlayback, VIDEO_INLINE_MAX_BYTES } from "./media.js";

const att = (over: Partial<Attachment> = {}): Attachment => ({
  id: "A1",
  filename: "file.bin",
  contentType: "application/octet-stream",
  size: 2048,
  width: null,
  height: null,
  hasThumbnail: false,
  animated: false,
  excerpt: null,
  excerptTruncated: false,
  removed: false,
  ...over,
});

const gif = (over: Partial<Attachment> = {}) =>
  att({
    filename: "dance.gif",
    contentType: "image/gif",
    width: 400,
    height: 300,
    hasThumbnail: true,
    animated: true,
    size: 1_000_000,
    ...over,
  });

function reducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: reduce && q.includes("reduce"),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => reducedMotion(false));
afterEach(() => vi.unstubAllGlobals());

describe("images", () => {
  it("shows a still thumbnail for a static image", () => {
    render(
      <AttachmentView
        a={att({ filename: "p.png", contentType: "image/png", width: 40, height: 30, hasThumbnail: true })}
      />,
    );
    expect(screen.getByRole("img", { name: "p.png" })).toHaveAttribute(
      "src",
      expect.stringContaining("?thumb=1"),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("animated images", () => {
  it("moves at once when small, and can be paused", () => {
    render(<AttachmentView a={gif()} />);
    const img = screen.getByRole("img", { name: "dance.gif" });
    expect(img.getAttribute("src")).not.toContain("thumb");
    expect(img).toHaveAttribute("loading", "lazy");
    const btn = screen.getByRole("button", { name: /Pause animation: dance\.gif/ });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(screen.getByRole("img", { name: "dance.gif" }).getAttribute("src")).toContain("thumb=1");
    expect(screen.getByRole("button", { name: /Play animation/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("waits for a click above the size threshold", () => {
    render(<AttachmentView a={gif({ size: ANIMATION_AUTOPLAY_MAX_BYTES + 1 })} />);
    expect(screen.getByRole("img").getAttribute("src")).toContain("thumb=1");
    fireEvent.click(screen.getByRole("button", { name: /Play animation/ }));
    expect(screen.getByRole("img").getAttribute("src")).not.toContain("thumb");
  });

  it("shows a still frame with a play control when the system asks for less motion", () => {
    reducedMotion(true);
    render(<AttachmentView a={gif({ size: 1000 })} />);
    expect(screen.getByRole("img").getAttribute("src")).toContain("thumb=1");
    fireEvent.click(screen.getByRole("button", { name: /Play animation/ }));
    expect(screen.getByRole("img").getAttribute("src")).not.toContain("thumb");
  });

  it("falls back to the still when the original cannot load", () => {
    render(<AttachmentView a={gif()} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("img").getAttribute("src")).toContain("thumb=1");
  });
});

describe("video", () => {
  const video = (over: Partial<Attachment> = {}) =>
    att({ filename: "clip.mp4", contentType: "video/mp4", size: 5_000_000, ...over });

  it("is a native player that does not start by itself, with a download link", () => {
    const { container } = render(<AttachmentView a={video()} />);
    const el = container.querySelector("video")!;
    expect(el).toHaveAttribute("controls");
    expect(el).toHaveAttribute("preload", "metadata");
    expect(el).not.toHaveAttribute("autoplay");
    expect(el.getAttribute("src")).toMatch(/\/files\/A1\/clip\.mp4#t=0\.1$/);
    expect(el).toHaveAttribute("aria-label", "Video: clip.mp4");
    expect(screen.getAllByRole("link", { name: /Download/ })[0]).toHaveAttribute("download", "clip.mp4");
  });

  it("turns into a file card with a message when the browser cannot play it", () => {
    const { container } = render(
      <AttachmentView a={video({ contentType: "video/quicktime", filename: "x.mov" })} />,
    );
    fireEvent.error(container.querySelector("video")!);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText(/can't play this video/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /x\.mov/ })).toHaveAttribute("download", "x.mov");
  });

  it("is only a file card above the inline size limit", () => {
    const { container } = render(<AttachmentView a={video({ size: VIDEO_INLINE_MAX_BYTES + 1 })} />);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText(/Video · /)).toBeInTheDocument();
  });
});

describe("audio", () => {
  const audio = att({ filename: "voice.ogg", contentType: "audio/ogg", size: 40_000 });

  it("is a labelled native player with the name and size", () => {
    const { container } = render(<AttachmentView a={audio} />);
    const el = container.querySelector("audio")!;
    expect(el).toHaveAttribute("controls");
    expect(el).toHaveAttribute("preload", "metadata");
    expect(el).toHaveAttribute("aria-label", "Audio: voice.ogg");
    expect(screen.getByText("voice.ogg")).toBeInTheDocument();
    expect(screen.getByText(/Audio · 39\.1 KB|Audio · 39 KB/)).toBeInTheDocument();
  });

  it("shows the duration once known", () => {
    const { container } = render(<AttachmentView a={audio} />);
    const el = container.querySelector("audio")!;
    Object.defineProperty(el, "duration", { value: 83, configurable: true });
    fireEvent.loadedMetadata(el);
    expect(screen.getByText(/· 1:23/)).toBeInTheDocument();
  });

  it("pauses the player that was playing when another one starts", () => {
    const { container } = render(
      <>
        <AttachmentView a={att({ id: "A1", filename: "one.ogg", contentType: "audio/ogg" })} />
        <AttachmentView a={att({ id: "A2", filename: "two.mp3", contentType: "audio/mpeg" })} />
      </>,
    );
    const [one, two] = [...container.querySelectorAll("audio")] as HTMLAudioElement[];
    const pause1 = vi.spyOn(one!, "pause").mockImplementation(() => undefined);
    const pause2 = vi.spyOn(two!, "pause").mockImplementation(() => undefined);
    // jsdom has no playback: `paused` stays true, so mark them as playing by hand.
    Object.defineProperty(one!, "paused", { value: false, configurable: true });
    Object.defineProperty(two!, "paused", { value: false, configurable: true });
    act(() => void fireEvent.play(one!));
    act(() => void fireEvent.play(two!));
    expect(pause1).toHaveBeenCalledTimes(1);
    expect(pause2).not.toHaveBeenCalled();
    claimPlayback(one!);
    expect(pause2).toHaveBeenCalledTimes(1);
  });
});

describe("other files", () => {
  it("shows an icon, a visible type word, the size and a download link", () => {
    render(
      <AttachmentView
        a={att({ filename: "budget.xlsx", contentType: "application/octet-stream", size: 3 * 1024 * 1024 })}
      />,
    );
    expect(screen.getByText("Spreadsheet · 3.0 MB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /budget\.xlsx/ })).toHaveAttribute("download", "budget.xlsx");
  });

  it("says when a file was removed", () => {
    render(<AttachmentView a={att({ removed: true })} />);
    expect(screen.getByText("File removed")).toBeInTheDocument();
  });
});

describe("text preview", () => {
  it("shows the start of a text file as escaped text, never as markup", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(
      <AttachmentView
        a={att({ filename: "page.html", excerpt: `${evil}\nsecond`, excerptTruncated: true, size: 9000 })}
      />,
    );
    const pre = screen.getByLabelText("Start of page.html");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toBe(`${evil}\nsecond`);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(pre.children).toHaveLength(0);
    expect(screen.getByText("Only the start is shown.")).toBeInTheDocument();
  });

  it("does not say the text was cut when it was not", () => {
    render(<AttachmentView a={att({ filename: "a.txt", excerpt: "hi", excerptTruncated: false })} />);
    expect(screen.queryByText("Only the start is shown.")).toBeNull();
  });

  it("is keyboard reachable", () => {
    render(<AttachmentView a={att({ filename: "a.txt", excerpt: "hi" })} />);
    expect(screen.getByLabelText("Start of a.txt")).toHaveAttribute("tabindex", "0");
  });
});
