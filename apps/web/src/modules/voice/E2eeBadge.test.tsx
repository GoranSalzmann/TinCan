// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useVoice } from "../../core/voice/store.js";
import { CallLock, isEncrypted } from "./E2eeBadge.js";

describe("which channels show the lock (10 §5)", () => {
  it.each([
    ["inherit", true, true],
    ["inherit", false, false],
    [undefined, true, true],
    ["required", false, true],
    ["required", true, true],
    ["off", true, false],
    ["off", false, false],
  ] as const)("%s with the server default %s → %s", (mode, serverDefault, expected) => {
    expect(isEncrypted(mode, serverDefault)).toBe(expected);
  });
});

describe("the lock in the call header", () => {
  beforeEach(() => useVoice.getState().reset());

  it("shows nothing in an unencrypted call", () => {
    const { container } = render(<CallLock />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says the call is end-to-end encrypted, with the limits in the tooltip", () => {
    useVoice.getState().patch({ e2ee: "on" });
    render(<CallLock />);
    const lock = screen.getByRole("status");
    expect(lock).toHaveTextContent("End-to-end encrypted");
    expect(lock.getAttribute("title")).toMatch(/server admin who manages the keys is still trusted/);
    expect(lock.getAttribute("title")).toMatch(/who is speaking stays visible/);
  });

  it("says so while it re-syncs the key", () => {
    useVoice.getState().patch({ e2ee: "resyncing" });
    render(<CallLock />);
    expect(screen.getByRole("status")).toHaveTextContent("Re-syncing encryption");
  });
});
