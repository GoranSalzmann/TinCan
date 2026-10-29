// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from "@testing-library/react";
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
