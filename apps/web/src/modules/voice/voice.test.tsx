// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PERM, type Channel, type Member } from "@tincan/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCommunity } from "../../core/state/community.js";
import { useVoice } from "../../core/voice/store.js";
import { CallView } from "./CallView.js";
import { ParticipantRow } from "./Participants.js";
import { VoiceDock } from "./VoiceDock.js";

const lounge = {
  id: "c1",
  type: "voice",
  name: "Lounge",
  categoryId: null,
  position: 0,
} as unknown as Channel;
const ann = {
  userId: "u1",
  username: "ann",
  displayName: "Ann",
  nickname: null,
  avatarKey: null,
} as unknown as Member;
const person = (userId: string, extra = {}) => ({
  userId,
  joinedAt: "2026-01-01T00:00:00Z",
  sources: [],
  muted: false,
  deafened: false,
  ...extra,
});

beforeEach(() => {
  useCommunity.setState({
    ready: true,
    channels: [lounge],
    members: { u1: ann },
    channelPermissions: { c1: PERM.CONNECT },
  });
});
afterEach(() => useVoice.getState().reset());

const view = () =>
  render(
    <MemoryRouter initialEntries={["/voice/c1"]}>
      <Routes>
        <Route path="/voice/:channelId" element={<CallView />} />
      </Routes>
    </MemoryRouter>,
  );

describe("voice UI", () => {
  it("renders the call view for an empty room without looping (selector returns a stable value)", () => {
    view();
    expect(screen.getByText("Nobody is here yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join voice" })).toBeEnabled();
  });

  it("lists the people in the room and marks who is speaking and who is muted", () => {
    useVoice.setState({
      presence: { c1: [person("u1", { muted: true })] },
      speaking: { u1: true },
    });
    view();
    expect(screen.getByText("Lounge · 1 person")).toBeInTheDocument();
    expect(screen.getByLabelText("Ann is speaking")).toBeInTheDocument();
    expect(screen.getByLabelText("muted")).toBeInTheDocument();
  });

  it("shows a sidebar row with the person's name", () => {
    render(
      <ul>
        <ParticipantRow p={person("u1", { deafened: true })} />
      </ul>,
    );
    expect(screen.getByText("Ann")).toBeInTheDocument();
    expect(screen.getByLabelText("deafened")).toBeInTheDocument();
  });

  it("shows nothing in the dock when idle, and the reason when a call ended", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <VoiceDock />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
    useVoice.setState({ notice: "joined_elsewhere" });
    rerender(
      <MemoryRouter>
        <VoiceDock />
      </MemoryRouter>,
    );
    expect(
      screen.getByText("You joined from another device, so this one left the call."),
    ).toBeInTheDocument();
  });

  it("offers mute, deafen and leave while connected", () => {
    useVoice.setState({ status: "connected", channelId: "c1" });
    render(
      <MemoryRouter>
        <VoiceDock />
      </MemoryRouter>,
    );
    expect(screen.getByText("Voice connected")).toBeInTheDocument();
    for (const name of ["Mute", "Deafen", "Leave voice channel"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});

describe("volume slider", () => {
  it("goes up to 300 %, remembers the value and says so above 100 %", async () => {
    localStorage.setItem("tincan.voice.volumes.v1", JSON.stringify({ u2: 2 }));
    const { VolumeSlider } = await import("./Participants.js");
    const seen: number[] = [];
    render(<VolumeSlider userId="u2" name="Bo" onVolume={(v) => seen.push(v)} />);
    const slider = screen.getByRole("slider", { name: "Volume for Bo" });
    expect(slider).toHaveAttribute("max", "3");
    expect(slider).toHaveValue("2");
    expect(screen.getByText("200% (boosted)")).toBeInTheDocument();
    localStorage.removeItem("tincan.voice.volumes.v1");
    expect(seen).toEqual([]);
  });
});

describe("camera and screen share in the call view (M4)", () => {
  const bo = {
    userId: "u2",
    username: "bo",
    displayName: "Bo",
    nickname: null,
    avatarKey: null,
  } as unknown as Member;

  beforeEach(() => {
    useCommunity.setState({ members: { u1: ann, u2: bo } });
  });

  it("shows a camera and a screen share as placeholders with Watch, never as video, until the viewer opts in", () => {
    useVoice.setState({
      status: "connected",
      channelId: "c1",
      presence: {
        c1: [person("u2", { sources: ["microphone", "camera", "screen_share", "screen_share_audio"] })],
      },
    });
    view();
    expect(screen.getByRole("button", { name: "Watch camera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Watch stream" })).toBeInTheDocument();
    expect(screen.getByText("Bo is sharing their screen")).toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
    expect(screen.queryByRole("region", { name: /stream/ })).toBeNull();
  });

  it("offers the controls only inside the call, with camera and screen disabled without permission", () => {
    useVoice.setState({ status: "connected", channelId: "c1", presence: { c1: [person("u1")] } });
    view();
    const camera = screen.getByRole("button", { name: "Turn camera on" });
    expect(camera).toBeDisabled();
    expect(camera).toHaveAttribute("title", "You don’t have permission to use a camera in this channel.");
    expect(screen.getByRole("button", { name: "Leave voice channel" })).toBeInTheDocument();
    act(() => useVoice.setState({ canCamera: true, canScreen: true }));
    expect(screen.getByRole("button", { name: "Turn camera on" })).toBeEnabled();
  });

  it("puts watched screens first and does not reorder when someone speaks", async () => {
    const { orderTiles } = await import("./CallView.js");
    const people = [
      person("u1"),
      person("u2", { sources: ["screen_share"] }),
      person("u3", { sources: ["screen_share"] }),
    ];
    const keys = (w: Record<string, true>, speaking = false) =>
      orderTiles(people, w, false, speaking ? "u3" : "u1").map((x) => x.key);
    expect(keys({})).toEqual(["u1:person", "u2:person", "u2:screen", "u3:person", "u3:screen"]);
    expect(keys({ "u3:screen": true })[0]).toBe("u3:screen");
    expect(keys({}, true)).toEqual(keys({}));
  });

  it("moves between tiles with the arrow keys; only the first is a tab stop", async () => {
    useVoice.setState({ presence: { c1: [person("u1"), person("u2")] } });
    view();
    const tiles = document.querySelectorAll<HTMLElement>("[data-tile]");
    expect([...tiles].map((x) => x.tabIndex)).toEqual([0, -1]);
    tiles[0]!.focus();
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.keyDown(tiles[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tiles[1]);
  });
});
