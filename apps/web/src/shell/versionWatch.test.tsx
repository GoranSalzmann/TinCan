// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../core/api/client.js";
import { useSession } from "../core/session/store.js";
import {
  CHECK_INTERVAL_MS,
  CHECK_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  resetUpdateChecks,
  useUpdate,
} from "../core/update/store.js";
import { APP_VERSION } from "../core/update/version.js";
import { PERIODIC_CHECK_MS, useVersionWatch } from "./UpdateBanner.js";

type Caps = Awaited<ReturnType<typeof api.capabilities>>;
const caps = (version: string): Caps => ({
  server: { name: "Tin Can", version, apiVersion: 1, sourceUrl: "https://example.test" },
  features: {},
  limits: {},
  auth: { methods: ["local"], signup: "invite-only", setupRequired: false },
});

const gateway = (state: "ready" | "reconnecting" | "closed") =>
  act(() => {
    useSession.setState({ gateway: state });
  });
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
  resetUpdateChecks();
  useSession.setState({ gateway: "closed" });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"); // jsdom reports "prerender"
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useVersionWatch", () => {
  it("checks when the gateway comes back after a drop, not on the first connect", async () => {
    const spy = vi.spyOn(api, "capabilities").mockResolvedValue(caps("9.9.9"));
    renderHook(() => useVersionWatch());
    gateway("ready");
    await flush();
    expect(spy).not.toHaveBeenCalled();
    gateway("reconnecting");
    gateway("ready");
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useUpdate.getState().reason).toBe("version");
  });

  it("does not let a check hung on a dead connection swallow the reconnect check", async () => {
    const spy = vi
      .spyOn(api, "capabilities")
      .mockImplementationOnce(() => new Promise<Caps>(() => undefined))
      .mockResolvedValue(caps("9.9.9"));
    renderHook(() => useVersionWatch());
    gateway("ready");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.setSystemTime(Date.now() + CHECK_INTERVAL_MS);
      window.dispatchEvent(new Event("focus"));
    });
    expect(spy).toHaveBeenCalledTimes(1); // the hanging one
    gateway("reconnecting");
    gateway("ready");
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useUpdate.getState().reason).toBe("version");
  });

  it("gives up on a hanging request and tries again", async () => {
    const spy = vi
      .spyOn(api, "capabilities")
      .mockImplementationOnce(
        (signal) =>
          new Promise<Caps>((_, reject) =>
            signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      )
      .mockResolvedValue(caps("9.9.9"));
    void useUpdate.getState().check({ force: true }); // never answers by itself
    await act(() => vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS));
    await act(() => vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useUpdate.getState().reason).toBe("version");
  });

  it("retries after the server was not ready yet, a limited number of times", async () => {
    const spy = vi.spyOn(api, "capabilities").mockRejectedValue(new Error("502"));
    await act(() => useUpdate.getState().check({ force: true }));
    for (const delay of RETRY_DELAYS_MS) await act(() => vi.advanceTimersByTimeAsync(delay));
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(spy).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);
    expect(useUpdate.getState().reason).toBeNull();
    spy.mockResolvedValue(caps("9.9.9"));
    await act(() => useUpdate.getState().check({ force: true }));
    expect(useUpdate.getState().reason).toBe("version");
  });

  it("stops retrying once a check succeeds", async () => {
    const spy = vi
      .spyOn(api, "capabilities")
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValue(caps(APP_VERSION));
    await act(() => useUpdate.getState().check({ force: true }));
    await act(() => vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!));
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a tab that stays visible gets the banner with no gateway event and no visibilitychange", async () => {
    const spy = vi.spyOn(api, "capabilities").mockResolvedValue(caps("9.9.9"));
    renderHook(() => useVersionWatch());
    await act(() => vi.advanceTimersByTimeAsync(PERIODIC_CHECK_MS));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useUpdate.getState().reason).toBe("version");
  });

  it("retries a failed check on the next tick", async () => {
    const spy = vi
      .spyOn(api, "capabilities")
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValue(caps("9.9.9"));
    renderHook(() => useVersionWatch());
    await act(() => vi.advanceTimersByTimeAsync(PERIODIC_CHECK_MS));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    await act(() => vi.advanceTimersByTimeAsync(PERIODIC_CHECK_MS));
    expect(useUpdate.getState().reason).toBe("version");
  });

  it("fetches nothing while hidden, and looks again when it can", async () => {
    const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const spy = vi.spyOn(api, "capabilities").mockResolvedValue(caps("9.9.9"));
    renderHook(() => useVersionWatch());
    await act(() => vi.advanceTimersByTimeAsync(5 * PERIODIC_CHECK_MS));
    expect(spy).not.toHaveBeenCalled();
    visible.mockReturnValue("visible");
    await act(() => vi.advanceTimersByTimeAsync(PERIODIC_CHECK_MS));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("makes one request per minute, never overlapping, and stops once the banner shows", async () => {
    const spy = vi.spyOn(api, "capabilities").mockResolvedValue(caps(APP_VERSION));
    renderHook(() => useVersionWatch());
    await act(() => vi.advanceTimersByTimeAsync(3 * PERIODIC_CHECK_MS));
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockResolvedValue(caps("9.9.9"));
    await act(() => vi.advanceTimersByTimeAsync(PERIODIC_CHECK_MS));
    expect(useUpdate.getState().reason).toBe("version");
    const seen = spy.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10 * PERIODIC_CHECK_MS));
    expect(spy).toHaveBeenCalledTimes(seen);
  });

  it("looks when the window is focused or the network returns, within the rate limit", async () => {
    const spy = vi.spyOn(api, "capabilities").mockResolvedValue(caps(APP_VERSION));
    renderHook(() => useVersionWatch());
    vi.setSystemTime(Date.now() + CHECK_INTERVAL_MS);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
