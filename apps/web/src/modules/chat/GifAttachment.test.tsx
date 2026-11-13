// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageGif } from "@tincan/shared";
import { GifAttachment } from "./GifAttachment.js";

const gif: MessageGif = { provider: "tenor", id: "t1", title: "cat dance", width: 498, height: 280 };

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

describe("GifAttachment", () => {
  it("plays the animation at once, always same-origin", () => {
    const { container } = render(<GifAttachment gif={gif} />);
    const img = screen.getByRole("img", { name: "cat dance" });
    expect(img).toHaveAttribute("src", "/api/v1/gifs/media/tenor/t1/full");
    expect(img).toHaveAttribute("loading", "lazy");
    // No provider URL may reach the DOM: the CSP only allows this origin (17 §10).
    expect(container.innerHTML).not.toMatch(/tenor\.com|giphy\.com|googleapis/);
    expect(screen.getByRole("button", { name: "Pause GIF cat dance" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the still under reduced motion and plays on demand", () => {
    reducedMotion(true);
    render(<GifAttachment gif={gif} />);
    expect(screen.getByRole("img", { name: "cat dance" })).toHaveAttribute(
      "src",
      "/api/v1/gifs/media/tenor/t1/still",
    );
    const play = screen.getByRole("button", { name: "Play GIF cat dance" });
    expect(play).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(play);
    expect(screen.getByRole("img", { name: "cat dance" })).toHaveAttribute(
      "src",
      "/api/v1/gifs/media/tenor/t1/full",
    );
  });

  it("pauses back to the still, and a failed animation leaves the still up", () => {
    render(<GifAttachment gif={gif} />);
    fireEvent.click(screen.getByRole("button", { name: "Pause GIF cat dance" }));
    expect(screen.getByRole("img", { name: "cat dance" })).toHaveAttribute(
      "src",
      "/api/v1/gifs/media/tenor/t1/still",
    );
    fireEvent.click(screen.getByRole("button", { name: "Play GIF cat dance" }));
    fireEvent.error(screen.getByRole("img", { name: "cat dance" }));
    expect(screen.getByRole("img", { name: "cat dance" })).toHaveAttribute(
      "src",
      "/api/v1/gifs/media/tenor/t1/still",
    );
    expect(screen.getByRole("button", { name: "Play GIF cat dance" })).toBeInTheDocument();
  });

  it("keeps a second provider's media on this server too", () => {
    render(<GifAttachment gif={{ ...gif, provider: "giphy", id: "g9" }} />);
    expect(screen.getByRole("img", { name: "cat dance" })).toHaveAttribute(
      "src",
      "/api/v1/gifs/media/giphy/g9/full",
    );
  });
});
