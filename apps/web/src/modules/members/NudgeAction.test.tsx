// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Capabilities, Member, User } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../core/api/client.js";
import { useSession } from "../../core/session/store.js";
import { useToasts } from "../../ui/toast.js";
import { NudgeAction } from "./NudgeAction.js";

const bo = {
  userId: "u-bo",
  username: "bo",
  displayName: "Bo",
  nickname: null,
  avatarKey: null,
  statusText: null,
  roleIds: [],
  isOwner: false,
  joinedAt: "2026-01-01T00:00:00.000Z",
} as Member;

const me = {
  id: "u-ann",
  username: "ann",
  displayName: "Ann",
  avatarKey: null,
  isInstanceOwner: false,
  createdAt: "2026-01-01T00:00:00.000Z",
} as User;

const caps = (on: boolean): Capabilities => ({
  server: { name: "Tin Can", version: "1", apiVersion: 1, sourceUrl: "https://example.test" },
  features: on ? { nudge: true } : {},
  limits: {},
  auth: { methods: ["local"], signup: "invite-only", setupRequired: false },
});

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useSession.setState({ user: me, capabilities: caps(true) });
});
afterEach(() => {
  useSession.setState({ user: null, capabilities: null });
  vi.restoreAllMocks();
});

describe("NudgeAction", () => {
  it("nudges the member and confirms with a toast", async () => {
    const spy = vi.spyOn(api, "nudge").mockResolvedValue({ online: true });
    render(<NudgeAction member={bo} />);
    await userEvent.click(screen.getByRole("button", { name: "Nudge Bo" }));
    expect(spy).toHaveBeenCalledWith("u-bo");
    await vi.waitFor(() => {
      expect(useToasts.getState().toasts.map((x) => x.text)).toContain("Nudge sent to Bo.");
    });
  });

  it("says when the member is offline and this server has no push", async () => {
    vi.spyOn(api, "nudge").mockResolvedValue({ online: false });
    render(<NudgeAction member={bo} />);
    await userEvent.click(screen.getByRole("button", { name: "Nudge Bo" }));
    await vi.waitFor(() => {
      expect(useToasts.getState().toasts.at(-1)?.text).toBe(
        "Bo is offline — nudges reach only online members on this server.",
      );
    });
  });

  it("is hidden for yourself and when the server offers no nudge", () => {
    const { container, rerender } = render(<NudgeAction member={{ ...bo, userId: me.id }} />);
    expect(container).toBeEmptyDOMElement();
    useSession.setState({ capabilities: caps(false) });
    rerender(<NudgeAction member={bo} />);
    expect(container).toBeEmptyDOMElement();
  });
});
