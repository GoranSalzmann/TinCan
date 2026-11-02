// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampWidth, readStoredWidth, ResizeHandle, usePanelWidth } from "./ResizeHandle.js";

const KEY = "test.panelWidth";

function Panel({ edge = "end", max = 480 }: { edge?: "start" | "end"; max?: number }) {
  const panel = usePanelWidth(KEY, 240, 200, max);
  return (
    <div style={{ width: panel.width }} data-testid="panel">
      <ResizeHandle label="Resize" edge={edge} panel={panel} min={200} max={max} />
    </div>
  );
}

const handle = () => screen.getByRole("separator", { name: "Resize" });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("clampWidth", () => {
  it("keeps a width between the limits and survives garbage", () => {
    expect(clampWidth(100, 200, 480)).toBe(200);
    expect(clampWidth(900, 200, 480)).toBe(480);
    expect(clampWidth(300.4, 200, 480)).toBe(300);
    expect(clampWidth(Number.NaN, 200, 480)).toBe(200);
    // A window too small for the panel: the minimum wins over the maximum.
    expect(clampWidth(300, 200, 150)).toBe(200);
  });
});

describe("readStoredWidth", () => {
  it("falls back when nothing or nonsense is stored, or storage throws", () => {
    expect(readStoredWidth(KEY, 240, 200, 480)).toBe(240);
    localStorage.setItem(KEY, "wide");
    expect(readStoredWidth(KEY, 240, 200, 480)).toBe(240);
    localStorage.setItem(KEY, "9999");
    expect(readStoredWidth(KEY, 240, 200, 480)).toBe(480);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredWidth(KEY, 240, 200, 480)).toBe(240);
  });
});

describe("ResizeHandle", () => {
  it("is a focusable vertical separator that reports its value and limits", () => {
    render(<Panel />);
    expect(handle()).toHaveAttribute("aria-orientation", "vertical");
    expect(handle()).toHaveAttribute("tabindex", "0");
    expect(handle()).toHaveAttribute("aria-valuenow", "240");
    expect(handle()).toHaveAttribute("aria-valuemin", "200");
    expect(handle()).toHaveAttribute("aria-valuemax", "480");
  });

  it("moves with the arrow keys, in bigger steps with Shift, and saves the result", async () => {
    const user = userEvent.setup();
    render(<Panel />);
    handle().focus();
    await user.keyboard("{ArrowRight}");
    expect(handle()).toHaveAttribute("aria-valuenow", "256");
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(handle()).toHaveAttribute("aria-valuenow", "320");
    await user.keyboard("{ArrowLeft}");
    expect(handle()).toHaveAttribute("aria-valuenow", "304");
    expect(localStorage.getItem(KEY)).toBe("304");
  });

  it("grows the other way for a panel whose handle is on its start edge", async () => {
    const user = userEvent.setup();
    render(<Panel edge="start" />);
    handle().focus();
    await user.keyboard("{ArrowLeft}");
    expect(handle()).toHaveAttribute("aria-valuenow", "256");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(handle()).toHaveAttribute("aria-valuenow", "224");
  });

  it("jumps to the limits with Home and End and never leaves them", async () => {
    const user = userEvent.setup();
    render(<Panel />);
    handle().focus();
    await user.keyboard("{Home}");
    expect(handle()).toHaveAttribute("aria-valuenow", "200");
    await user.keyboard("{ArrowLeft}");
    expect(handle()).toHaveAttribute("aria-valuenow", "200");
    await user.keyboard("{End}{ArrowRight}");
    expect(handle()).toHaveAttribute("aria-valuenow", "480");
  });

  it("goes back to the default with Enter or a double click, and forgets the saved width", async () => {
    const user = userEvent.setup();
    render(<Panel />);
    handle().focus();
    await user.keyboard("{End}");
    expect(localStorage.getItem(KEY)).toBe("480");
    await user.keyboard("{Enter}");
    expect(handle()).toHaveAttribute("aria-valuenow", "240");
    expect(localStorage.getItem(KEY)).toBeNull();
    await user.keyboard("{End}");
    fireEvent.doubleClick(handle());
    expect(handle()).toHaveAttribute("aria-valuenow", "240");
  });

  it("follows a pointer drag with the pointer captured, and saves when it ends", () => {
    render(<Panel />);
    const el = handle();
    const capture = vi.fn();
    const release = vi.fn();
    el.setPointerCapture = capture;
    el.releasePointerCapture = release;
    fireEvent.pointerDown(el, { pointerId: 7, button: 0, clientX: 240 });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 300 });
    expect(el).toHaveAttribute("aria-valuenow", "300");
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 900 });
    expect(el).toHaveAttribute("aria-valuenow", "480");
    fireEvent.pointerUp(el, { pointerId: 7, clientX: 280 });
    expect(release).toHaveBeenCalledWith(7);
    expect(el).toHaveAttribute("aria-valuenow", "280");
    expect(localStorage.getItem(KEY)).toBe("280");
    // Moving without a button held changes nothing.
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 400 });
    expect(el).toHaveAttribute("aria-valuenow", "280");
  });

  it("drags the other way on a start-edge handle", () => {
    render(<Panel edge="start" />);
    fireEvent.pointerDown(handle(), { pointerId: 1, button: 0, clientX: 500 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 450 });
    expect(handle()).toHaveAttribute("aria-valuenow", "290");
  });

  it("starts from the saved width, within the current maximum", () => {
    localStorage.setItem(KEY, "400");
    const { unmount } = render(<Panel />);
    expect(handle()).toHaveAttribute("aria-valuenow", "400");
    unmount();
    render(<Panel max={320} />);
    expect(handle()).toHaveAttribute("aria-valuenow", "320");
    // The saved choice is not overwritten just because the window was small.
    expect(localStorage.getItem(KEY)).toBe("400");
  });

  it("works when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    render(<Panel />);
    handle().focus();
    await user.keyboard("{ArrowRight}");
    expect(handle()).toHaveAttribute("aria-valuenow", "256");
  });
});
