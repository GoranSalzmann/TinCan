// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client.js";
import { UpdateBanner } from "../../shell/UpdateBanner.js";
import { useVoice } from "../voice/store.js";
import { isChunkLoadError, recoverFromChunkError } from "./recovery.js";
import { RELOAD_WINDOW_MS, takeAutoReload } from "./reloadGuard.js";
import { CHECK_INTERVAL_MS, resetUpdateChecks, useUpdate } from "./store.js";
import { APP_VERSION, isVersionMismatch } from "./version.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

function serverSays(version: string) {
  return vi.spyOn(api, "capabilities").mockResolvedValue({
    server: { name: "Tin Can", version, apiVersion: 1, sourceUrl: "https://example.test" },
    features: {},
    limits: {},
    auth: { methods: ["local"], signup: "invite-only", setupRequired: false },
  });
}

beforeEach(() => resetUpdateChecks());
afterEach(() => {
  vi.restoreAllMocks();
  useVoice.getState().reset();
});

describe("version comparison", () => {
  it("knows the build's own version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
  it("differs only for a different, known version", () => {
    expect(isVersionMismatch("1.0.2", "1.0.1")).toBe(true);
    expect(isVersionMismatch("1.0.1", "1.0.1")).toBe(false);
    expect(isVersionMismatch("", "1.0.1")).toBe(false);
    expect(isVersionMismatch(undefined, "1.0.1")).toBe(false);
  });
});

describe("reload loop guard", () => {
  it("allows one reload, then refuses inside the window and allows again after it", () => {
    const store = memoryStorage();
    expect(takeAutoReload(1_000_000, store)).toBe(true);
    expect(takeAutoReload(1_000_000 + 5_000, store)).toBe(false);
    expect(takeAutoReload(1_000_000 + RELOAD_WINDOW_MS, store)).toBe(true);
  });
  it("refuses when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
    };
    expect(takeAutoReload(1_000_000, broken)).toBe(false);
  });
});

describe("chunk load recovery", () => {
  it("recognises the browsers' messages", () => {
    expect(
      isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/a.js")),
    ).toBe(true);
    expect(isChunkLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
  it("reloads once, then shows the banner instead of looping", () => {
    sessionStorage.clear();
    const reload = vi.fn();
    expect(recoverFromChunkError({ reload, inCall: () => false, now: () => 5_000_000 })).toBe("reloaded");
    expect(recoverFromChunkError({ reload, inCall: () => false, now: () => 5_001_000 })).toBe("banner");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useUpdate.getState().reason).toBe("stale");
  });
  it("never reloads during a call", () => {
    sessionStorage.clear();
    const reload = vi.fn();
    expect(recoverFromChunkError({ reload, inCall: () => true })).toBe("banner");
    expect(reload).not.toHaveBeenCalled();
    expect(useUpdate.getState().reason).toBe("stale");
  });
});

describe("version check", () => {
  it("flags a different server version and clears when it matches again", async () => {
    serverSays("9.9.9");
    await useUpdate.getState().check({ force: true });
    expect(useUpdate.getState().reason).toBe("version");
    expect(useUpdate.getState().serverVersion).toBe("9.9.9");
    serverSays(APP_VERSION);
    await useUpdate.getState().check({ force: true });
    expect(useUpdate.getState().reason).toBeNull();
  });
  it("is rate limited unless forced, and survives an unreachable server", async () => {
    const spy = serverSays("9.9.9");
    await useUpdate.getState().check({ now: 1_000_000 });
    await useUpdate.getState().check({ now: 1_000_000 + CHECK_INTERVAL_MS - 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    await useUpdate.getState().check({ now: 1_000_000 + CHECK_INTERVAL_MS });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRejectedValue(new Error("down"));
    await useUpdate.getState().check({ force: true });
    expect(useUpdate.getState().reason).toBe("version");
  });
  it("brings a dismissed banner back at the next check that still differs", async () => {
    serverSays("9.9.9");
    await useUpdate.getState().check({ force: true });
    useUpdate.getState().dismiss();
    expect(useUpdate.getState().dismissed).toBe(true);
    await useUpdate.getState().check({ force: true });
    expect(useUpdate.getState().dismissed).toBe(false);
  });
});

describe("UpdateBanner", () => {
  it("renders an empty live region until there is an update", () => {
    render(<UpdateBanner />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
  it("offers Reload and Dismiss without taking focus", async () => {
    render(<UpdateBanner />);
    useUpdate.setState({ reason: "version", serverVersion: "9.9.9", dismissed: false });
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/updated on the server/i);
    expect(status).not.toHaveTextContent(/current call/i);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(document.body).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(status).toBeEmptyDOMElement();
  });
  it("says a reload leaves the call, without promising it survives", async () => {
    useVoice.setState({ status: "connected" });
    render(<UpdateBanner />);
    useUpdate.setState({ reason: "stale", serverVersion: null, dismissed: false });
    expect(await screen.findByRole("status")).toHaveTextContent(/out of date.*leave your current call/i);
  });
});
