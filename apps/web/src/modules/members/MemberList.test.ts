// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Member, Role } from "@tincan/shared";
import { groupMembers } from "./MemberList.js";

const labels = { owner: "Owner", online: "Online", offline: "Offline" };

function member(userId: string, extra: Partial<Member> = {}): Member {
  return {
    userId,
    username: userId,
    displayName: userId,
    avatarKey: null,
    statusText: null,
    roleIds: [],
    isOwner: false,
    joinedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as Member;
}

const admins = { id: "R-admin", name: "Admins", hoist: true, isDefault: false, position: 5 } as Role;

describe("groupMembers", () => {
  it("puts the owner in a group above the hoisted roles, even when they also hold one", () => {
    const people = [
      member("zed", { isOwner: true, roleIds: [admins.id] }),
      member("amy", { roleIds: [admins.id] }),
      member("bob"),
    ];
    const groups = groupMembers(people, [admins], { zed: "online", amy: "online", bob: "idle" }, labels);
    expect(groups.map((g) => [g.title, g.members.map((m) => m.userId)])).toEqual([
      ["Owner", ["zed"]],
      ["Admins", ["amy"]],
      ["Online", ["bob"]],
    ]);
  });

  it("lists an owner who is offline under Offline, like any other offline member", () => {
    const people = [member("zed", { isOwner: true }), member("bob")];
    const groups = groupMembers(people, [], { bob: "online" }, labels);
    expect(groups.map((g) => g.key)).toEqual(["online", "offline"]);
    expect(groups[1]?.members.map((m) => m.userId)).toEqual(["zed"]);
  });

  it("has no owner group when nobody holds the flag", () => {
    const groups = groupMembers([member("bob")], [], { bob: "online" }, labels);
    expect(groups.map((g) => g.key)).toEqual(["online"]);
  });
});
