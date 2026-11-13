// SPDX-License-Identifier: AGPL-3.0-or-later
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GifItem, GifProvider } from "@tincan/shared";
import { api } from "../../core/api/client.js";
import { GifPicker } from "./GifPicker.js";

const item = (id: string, provider: GifProvider = "tenor"): GifItem => ({
  provider,
  id,
  title: `gif ${id}`,
  width: 400,
  height: 225,
  previewUrl: `/api/v1/gifs/media/${provider}/${id}/preview`,
  mediaUrl: `/api/v1/gifs/media/${provider}/${id}/full`,
});

const page = (items: GifItem[], next = "") => ({ items, next });

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function picker(providers: GifProvider[] = ["tenor"], onPick = vi.fn(), onClose = vi.fn()) {
  return {
    onPick,
    onClose,
    ...render(<GifPicker providers={providers} onPick={onPick} onClose={onClose} />),
  };
}

describe("GifPicker", () => {
  it("lists trending GIFs on open, every image same-origin", async () => {
    vi.spyOn(api, "trendingGifs").mockResolvedValue(page([item("1"), item("2")]));
    const { container } = picker();
    await waitFor(() => expect(screen.getByRole("button", { name: "gif 1" })).toBeInTheDocument());
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) expect(img.getAttribute("src")).toMatch(/^\/api\/v1\/gifs\/media\//);
    // Nothing may point at a provider host: the CSP only allows this origin (17 §10).
    expect(container.innerHTML).not.toMatch(/tenor\.com|giphy\.com|googleapis/);
    expect(api.trendingGifs).toHaveBeenCalledWith("tenor", undefined);
  });

  it("picks a GIF and files it under recently used", async () => {
    vi.spyOn(api, "trendingGifs").mockResolvedValue(page([item("7")]));
    const { onPick, unmount } = picker();
    await waitFor(() => screen.getByRole("button", { name: "gif 7" }));
    fireEvent.click(screen.getByRole("button", { name: "gif 7" }));
    expect(onPick).toHaveBeenCalledWith(item("7"));
    unmount();
    vi.spyOn(api, "trendingGifs").mockResolvedValue(page([]));
    picker();
    expect(await screen.findByText("Recently used")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "gif 7" })).toBeInTheDocument();
  });

  it("switches between the configured providers", async () => {
    const trending = vi
      .spyOn(api, "trendingGifs")
      .mockImplementation(async (p: GifProvider) => page([item(`x-${p}`, p)]));
    picker(["tenor", "giphy"]);
    await waitFor(() => screen.getByRole("button", { name: "gif x-tenor" }));
    fireEvent.click(screen.getByRole("tab", { name: "GIPHY" }));
    await waitFor(() => expect(trending).toHaveBeenCalledWith("giphy", undefined));
    expect(await screen.findByRole("button", { name: "gif x-giphy" })).toBeInTheDocument();
  });

  it("searches what is typed after a short pause", async () => {
    const search = vi.spyOn(api, "searchGifs").mockResolvedValue(page([item("s1")]));
    vi.spyOn(api, "trendingGifs").mockResolvedValue(page([]));
    picker();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "cats" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("tenor", "cats", undefined), {
      timeout: 2000,
    });
    expect(await screen.findByRole("button", { name: "gif s1" })).toBeInTheDocument();
  });

  it("offers a retry after a load failure and closes on Escape", async () => {
    const trending = vi
      .spyOn(api, "trendingGifs")
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValue(page([item("ok")]));
    const { onClose } = picker();
    expect(await screen.findByText("GIFs could not be loaded. Try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(trending).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
