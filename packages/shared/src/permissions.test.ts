// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSIONS,
  ALL_PERMISSIONS,
  CHANNEL_SCOPED,
  EVERYONE_PERMISSIONS,
  MODERATOR_PERMISSIONS,
  PERM,
  PERMISSION_BITS,
  PERMISSION_NAMES,
  authorizeAction,
  basePermissions,
  bitsOf,
  channelPermissions,
  highestPosition,
  parsePermissions,
  permissionsToString,
  type Action,
  type ActorFacts,
  type MemberFacts,
  type OverwriteFacts,
  type RoleFacts,
  type RoleSet,
} from "./permissions.js";

const everyone: RoleFacts = { id: "everyone", position: 0, permissions: EVERYONE_PERMISSIONS };
const mod: RoleFacts = { id: "mod", position: 10, permissions: MODERATOR_PERMISSIONS };
const admin: RoleFacts = { id: "admin", position: 20, permissions: ADMIN_PERMISSIONS };
const muted: RoleFacts = { id: "muted", position: 5, permissions: 0n };
const superRole: RoleFacts = { id: "super", position: 30, permissions: PERM.ADMINISTRATOR };

const set: RoleSet = {
  everyone,
  roles: new Map([mod, admin, muted, superRole].map((r) => [r.id, r])),
};

const member = (roleIds: string[] = [], extra: Partial<MemberFacts> = {}): MemberFacts => ({
  userId: "u1",
  isOwner: false,
  roleIds,
  ...extra,
});

const ow = (
  targetType: "role" | "member",
  targetId: string,
  allow: bigint,
  deny: bigint,
): OverwriteFacts => ({ targetType, targetId, allow, deny });

describe("catalogue", () => {
  it("has unique, stable bit positions", () => {
    const bits = Object.values(PERMISSION_BITS);
    expect(new Set(bits).size).toBe(bits.length);
    // Pinned so a reshuffle shows up as a failing test (11 §2.2: never reassigned).
    expect(PERMISSION_BITS.VIEW_CHANNEL).toBe(0);
    expect(PERMISSION_BITS.MANAGE_CHANNELS).toBe(15);
    expect(PERMISSION_BITS.ADMINISTRATOR).toBe(26);
  });

  it("round-trips decimal strings and rejects junk", () => {
    expect(parsePermissions(permissionsToString(ADMIN_PERMISSIONS))).toBe(ADMIN_PERMISSIONS);
    expect(permissionsToString(1n << 63n)).toBe("9223372036854775808");
    expect(() => parsePermissions("-1")).toThrow();
    expect(() => parsePermissions("1e3")).toThrow();
    expect(() => parsePermissions("18446744073709551616")).toThrow();
  });

  it("keeps the default bundles nested", () => {
    expect(EVERYONE_PERMISSIONS & MODERATOR_PERMISSIONS).toBe(EVERYONE_PERMISSIONS);
    expect(MODERATOR_PERMISSIONS & ADMIN_PERMISSIONS).toBe(MODERATOR_PERMISSIONS);
    expect(ADMIN_PERMISSIONS & PERM.ADMINISTRATOR).toBe(0n);
  });
});

describe("basePermissions", () => {
  it("gives @everyone's bits to a member without roles", () => {
    expect(basePermissions(member(), set)).toBe(EVERYONE_PERMISSIONS);
  });
  it("ORs the roles in", () => {
    expect(basePermissions(member(["mod"]), set)).toBe(MODERATOR_PERMISSIONS);
  });
  it("ignores unknown role IDs", () => {
    expect(basePermissions(member(["gone"]), set)).toBe(EVERYONE_PERMISSIONS);
  });
  it("gives the owner and ADMINISTRATOR everything", () => {
    expect(basePermissions(member([], { isOwner: true }), set)).toBe(ALL_PERMISSIONS);
    expect(basePermissions(member(["super"]), set)).toBe(ALL_PERMISSIONS);
  });
});

describe("channelPermissions (table-driven, order of 11 §2.3)", () => {
  interface Row {
    name: string;
    member: MemberFacts;
    overwrites: OverwriteFacts[];
    expectAllowed?: (keyof typeof PERM)[];
    expectDenied?: (keyof typeof PERM)[];
  }
  const rows: Row[] = [
    {
      name: "no overwrites: base permissions apply",
      member: member(),
      overwrites: [],
      expectAllowed: ["VIEW_CHANNEL", "SEND_MESSAGES"],
      expectDenied: ["MANAGE_MESSAGES"],
    },
    {
      name: "@everyone deny of SEND_MESSAGES",
      member: member(),
      overwrites: [ow("role", "everyone", 0n, PERM.SEND_MESSAGES)],
      expectAllowed: ["VIEW_CHANNEL", "READ_HISTORY"],
      expectDenied: ["SEND_MESSAGES"],
    },
    {
      name: "a role allow beats the @everyone deny",
      member: member(["mod"]),
      overwrites: [ow("role", "everyone", 0n, PERM.SEND_MESSAGES), ow("role", "mod", PERM.SEND_MESSAGES, 0n)],
      expectAllowed: ["SEND_MESSAGES"],
    },
    {
      name: "role denies and allows aggregate: allow wins over deny among roles",
      member: member(["mod", "muted"]),
      overwrites: [ow("role", "muted", 0n, PERM.SEND_MESSAGES), ow("role", "mod", PERM.SEND_MESSAGES, 0n)],
      expectAllowed: ["SEND_MESSAGES"],
    },
    {
      name: "a member overwrite beats the role overwrites",
      member: member(["mod"]),
      overwrites: [ow("role", "mod", PERM.SEND_MESSAGES, 0n), ow("member", "u1", 0n, PERM.SEND_MESSAGES)],
      expectDenied: ["SEND_MESSAGES"],
    },
    {
      name: "a member allow beats an @everyone deny",
      member: member(),
      overwrites: [ow("role", "everyone", 0n, PERM.ATTACH_FILES), ow("member", "u1", PERM.ATTACH_FILES, 0n)],
      expectAllowed: ["ATTACH_FILES"],
    },
    {
      name: "overwrites of other members and roles do not apply",
      member: member(),
      overwrites: [
        ow("member", "someone-else", 0n, PERM.SEND_MESSAGES),
        ow("role", "mod", 0n, PERM.SEND_MESSAGES),
      ],
      expectAllowed: ["SEND_MESSAGES"],
    },
    {
      name: "without VIEW_CHANNEL every channel bit goes",
      member: member(),
      overwrites: [ow("role", "everyone", 0n, PERM.VIEW_CHANNEL)],
      expectDenied: ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_HISTORY", "ATTACH_FILES"],
    },
    {
      name: "a private channel: deny @everyone, allow one role",
      member: member(["mod"]),
      overwrites: [ow("role", "everyone", 0n, PERM.VIEW_CHANNEL), ow("role", "mod", PERM.VIEW_CHANNEL, 0n)],
      expectAllowed: ["VIEW_CHANNEL", "SEND_MESSAGES"],
    },
    {
      name: "an allow cannot grant what only the allow names: view comes back, send does not",
      member: member(["muted"]),
      overwrites: [
        ow("role", "everyone", 0n, PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES),
        ow("role", "muted", PERM.VIEW_CHANNEL, 0n),
      ],
      expectAllowed: ["VIEW_CHANNEL"],
      expectDenied: ["SEND_MESSAGES"],
    },
    {
      name: "administrators ignore overwrites",
      member: member(["super"]),
      overwrites: [ow("role", "everyone", 0n, PERM.VIEW_CHANNEL), ow("member", "u1", 0n, PERM.VIEW_CHANNEL)],
      expectAllowed: ["VIEW_CHANNEL", "SEND_MESSAGES", "MANAGE_ROLES"],
    },
    {
      name: "the owner ignores overwrites",
      member: member([], { isOwner: true }),
      overwrites: [ow("member", "u1", 0n, ALL_PERMISSIONS)],
      expectAllowed: ["VIEW_CHANNEL", "ADMINISTRATOR"],
    },
    {
      name: "a timeout keeps view and read, removes the rest",
      member: member(["mod"], { timedOut: true }),
      overwrites: [ow("member", "u1", PERM.SEND_MESSAGES, 0n)],
      expectAllowed: ["VIEW_CHANNEL", "READ_HISTORY", "MANAGE_MESSAGES"],
      expectDenied: ["SEND_MESSAGES", "ADD_REACTIONS", "SPEAK", "VIDEO", "SCREEN_SHARE"],
    },
    {
      name: "overwrites cannot change instance-wide bits",
      member: member(),
      overwrites: [ow("role", "everyone", PERM.MANAGE_ROLES | PERM.ADMINISTRATOR, PERM.CREATE_INVITE)],
      expectDenied: ["MANAGE_ROLES", "ADMINISTRATOR"],
      expectAllowed: ["CREATE_INVITE"],
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const p = channelPermissions(row.member, set, row.overwrites, "text");
      for (const n of row.expectAllowed ?? []) expect(p & PERM[n], `${n} allowed`).toBe(PERM[n]);
      for (const n of row.expectDenied ?? []) expect(p & PERM[n], `${n} denied`).toBe(0n);
    });
  }

  it("drops voice bits in a text channel and text bits in a voice channel", () => {
    const text = channelPermissions(member(), set, [], "text");
    const voice = channelPermissions(member(), set, [], "voice");
    expect(text & PERM.SPEAK).toBe(0n);
    expect(voice & PERM.SEND_MESSAGES).toBe(0n);
    expect(voice & PERM.CONNECT).toBe(PERM.CONNECT);
    expect(voice & PERM.VIEW_CHANNEL).toBe(PERM.VIEW_CHANNEL);
  });

  it("explains each step", () => {
    const trace: Parameters<typeof channelPermissions>[4] = [];
    channelPermissions(member(), set, [ow("role", "everyone", 0n, PERM.SEND_MESSAGES)], "text", trace);
    expect(trace!.map((t) => t.step)).toEqual([
      "base (owner, @everyone and roles)",
      "@everyone overwrite",
      "bits that do not apply to a text channel",
    ]);
    expect(trace![1]!.before & PERM.SEND_MESSAGES).toBe(PERM.SEND_MESSAGES);
    expect(trace![1]!.after & PERM.SEND_MESSAGES).toBe(0n);
  });
});

// ---- property tests: a small seeded generator keeps this dependency-free and reproducible --------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function randomBits(r: () => number, density = 0.4): bigint {
  let v = 0n;
  for (const n of PERMISSION_NAMES) if (r() < density) v |= PERM[n];
  return v;
}

function scenario(r: () => number) {
  const roles = new Map<string, RoleFacts>();
  const count = 1 + Math.floor(r() * 4);
  for (let i = 0; i < count; i++) {
    const id = `r${i}`;
    roles.set(id, { id, position: 1 + i * 3, permissions: randomBits(r) & ~PERM.ADMINISTRATOR });
  }
  const rs: RoleSet = {
    everyone: { id: "everyone", position: 0, permissions: randomBits(r) & ~PERM.ADMINISTRATOR },
    roles,
  };
  const m: MemberFacts = {
    userId: "u1",
    isOwner: false,
    roleIds: [...roles.keys()].filter(() => r() < 0.5),
    timedOut: r() < 0.2,
  };
  const overwrites: OverwriteFacts[] = [];
  for (const id of ["everyone", ...roles.keys()]) {
    if (r() < 0.5) overwrites.push(ow("role", id, randomBits(r, 0.2), randomBits(r, 0.2)));
  }
  if (r() < 0.4) overwrites.push(ow("member", "u1", randomBits(r, 0.2), randomBits(r, 0.2)));
  return { rs, m, overwrites };
}

describe("channelPermissions (properties)", () => {
  const runs = 400;

  it("is deterministic and independent of overwrite order", () => {
    const r = rng(1);
    for (let i = 0; i < runs; i++) {
      const { rs, m, overwrites } = scenario(r);
      const a = channelPermissions(m, rs, overwrites, "text");
      const b = channelPermissions(m, rs, [...overwrites].reverse(), "text");
      expect(a).toBe(b);
      expect(channelPermissions(m, rs, overwrites, "text")).toBe(a);
    }
  });

  it("never exceeds the defined bits and is empty of channel bits without VIEW_CHANNEL", () => {
    const r = rng(2);
    for (let i = 0; i < runs; i++) {
      const { rs, m, overwrites } = scenario(r);
      const p = channelPermissions(m, rs, overwrites, "text");
      expect(p & ~ALL_PERMISSIONS).toBe(0n);
      if ((p & PERM.VIEW_CHANNEL) === 0n) expect(p & CHANNEL_SCOPED).toBe(0n);
    }
  });

  it("monotonic deny: adding a deny to the member overwrite never grants a bit", () => {
    const r = rng(3);
    for (let i = 0; i < runs; i++) {
      const { rs, m, overwrites } = scenario(r);
      const others = overwrites.filter((o) => o.targetType !== "member");
      const existing = overwrites.find((o) => o.targetType === "member");
      const without = channelPermissions(m, rs, [...others, ...(existing ? [existing] : [])], "text");
      const extra = randomBits(r, 0.15);
      const denied = ow("member", "u1", existing?.allow ?? 0n, (existing?.deny ?? 0n) | extra);
      const after = channelPermissions(m, rs, [...others, denied], "text");
      // The extra deny only matters where the allow does not re-grant the bit; either way nothing new appears.
      expect(after & ~without & ~(existing?.allow ?? 0n)).toBe(0n);
    }
  });

  it("a timeout never adds a bit", () => {
    const r = rng(4);
    for (let i = 0; i < runs; i++) {
      const { rs, m, overwrites } = scenario(r);
      const free = channelPermissions({ ...m, timedOut: false }, rs, overwrites, "text");
      const timed = channelPermissions({ ...m, timedOut: true }, rs, overwrites, "text");
      expect(timed & ~free).toBe(0n);
      expect(timed & TIMEOUT).toBe(0n);
    }
  });

  it("granting a role to a member without overwrites never removes a bit", () => {
    const r = rng(5);
    for (let i = 0; i < runs; i++) {
      const { rs, m } = scenario(r);
      const without = channelPermissions({ ...m, roleIds: [] }, rs, [], "text");
      const withAll = channelPermissions({ ...m, roleIds: [...rs.roles.keys()] }, rs, [], "text");
      expect(without & ~withAll & ~TIMEOUT).toBe(0n);
    }
  });
});

const TIMEOUT = PERM.SEND_MESSAGES | PERM.ADD_REACTIONS | PERM.SPEAK | PERM.VIDEO | PERM.SCREEN_SHARE;

// ---- hierarchy -----------------------------------------------------------------------------------

function actorOf(roleIds: string[], isOwner = false): ActorFacts {
  const m = member(roleIds, { isOwner });
  return { isOwner, permissions: basePermissions(m, set), rank: highestPosition(m, set) };
}
const target = (roleIds: string[], isOwner = false) => {
  const m = member(roleIds, { userId: "t", isOwner });
  return { userId: "t", isOwner, rank: highestPosition(m, set) };
};
const roleFacts = (r: RoleFacts) => ({ position: r.position, permissions: r.permissions });

describe("authorizeAction", () => {
  const adminActor = actorOf(["admin"]);
  const modActor = actorOf(["mod"]);
  const plain = actorOf([]);
  const owner = actorOf([], true);

  it("ranks the owner above everything", () => {
    expect(highestPosition(member([], { isOwner: true }), set)).toBe(Number.POSITIVE_INFINITY);
    expect(highestPosition(member(["mod", "admin"]), set)).toBe(20);
    expect(highestPosition(member(), set)).toBe(0);
  });

  const cases: { name: string; actor: ActorFacts; action: Action; ok: boolean }[] = [
    {
      name: "plain members cannot manage roles",
      actor: plain,
      action: { kind: "role.create", position: 1, permissions: 0n },
      ok: false,
    },
    {
      name: "admin creates a role below own rank",
      actor: adminActor,
      action: { kind: "role.create", position: 19, permissions: PERM.SEND_MESSAGES },
      ok: true,
    },
    {
      name: "admin cannot create a role at own rank",
      actor: adminActor,
      action: { kind: "role.create", position: 20, permissions: 0n },
      ok: false,
    },
    {
      name: "admin cannot create a role with ADMINISTRATOR (not held)",
      actor: adminActor,
      action: { kind: "role.create", position: 1, permissions: PERM.ADMINISTRATOR },
      ok: false,
    },
    {
      name: "admin edits a lower role",
      actor: adminActor,
      action: { kind: "role.update", role: roleFacts(mod), newPermissions: PERM.SEND_MESSAGES },
      ok: true,
    },
    {
      name: "admin cannot edit own role",
      actor: adminActor,
      action: { kind: "role.update", role: roleFacts(admin), newPermissions: 0n },
      ok: false,
    },
    {
      name: "admin cannot raise a role to own rank",
      actor: adminActor,
      action: { kind: "role.update", role: roleFacts(mod), newPosition: 20 },
      ok: false,
    },
    {
      name: "admin cannot add a bit it lacks",
      actor: adminActor,
      action: {
        kind: "role.update",
        role: roleFacts(mod),
        newPermissions: MODERATOR_PERMISSIONS | PERM.ADMINISTRATOR,
      },
      ok: false,
    },
    {
      name: "keeping an existing bit is not an escalation",
      actor: adminActor,
      action: { kind: "role.update", role: roleFacts(muted), newPermissions: 0n },
      ok: true,
    },
    {
      name: "admin edits @everyone within own bits",
      actor: adminActor,
      action: {
        kind: "role.update",
        role: { position: 0, permissions: EVERYONE_PERMISSIONS, isDefault: true },
        newPermissions: EVERYONE_PERMISSIONS | PERM.MENTION_EVERYONE,
      },
      ok: true,
    },
    {
      name: "@everyone cannot be moved",
      actor: adminActor,
      action: {
        kind: "role.update",
        role: { position: 0, permissions: 0n, isDefault: true },
        newPosition: 3,
      },
      ok: false,
    },
    {
      name: "@everyone cannot be deleted",
      actor: owner,
      action: { kind: "role.delete", role: { position: 0, permissions: 0n, isDefault: true } },
      ok: false,
    },
    {
      name: "managed roles cannot be deleted",
      actor: owner,
      action: { kind: "role.delete", role: { position: 1, permissions: 0n, isManaged: true } },
      ok: false,
    },
    {
      name: "admin deletes a lower role",
      actor: adminActor,
      action: { kind: "role.delete", role: roleFacts(mod) },
      ok: true,
    },
    {
      name: "moderator cannot delete roles",
      actor: modActor,
      action: { kind: "role.delete", role: roleFacts(muted) },
      ok: false,
    },
    {
      name: "admin assigns a lower role to a lower member",
      actor: adminActor,
      action: { kind: "role.assign", role: roleFacts(mod), member: target([]) },
      ok: true,
    },
    {
      name: "admin cannot assign a role to a peer",
      actor: adminActor,
      action: { kind: "role.assign", role: roleFacts(mod), member: target(["admin"]) },
      ok: false,
    },
    {
      name: "admin cannot assign to the owner",
      actor: adminActor,
      action: { kind: "role.assign", role: roleFacts(muted), member: target([], true) },
      ok: false,
    },
    {
      name: "admin cannot assign a role above own rank",
      actor: adminActor,
      action: { kind: "role.assign", role: roleFacts(superRole), member: target([]) },
      ok: false,
    },
    {
      name: "owner assigns anything",
      actor: owner,
      action: { kind: "role.assign", role: roleFacts(superRole), member: target(["admin"]) },
      ok: true,
    },
    {
      name: "removing a role needs the same rank",
      actor: adminActor,
      action: { kind: "role.unassign", role: roleFacts(superRole), member: target([]) },
      ok: false,
    },
    {
      name: "moderator kicks a plain member",
      actor: modActor,
      action: { kind: "member.kick", member: target([]) },
      ok: true,
    },
    {
      name: "moderator cannot kick an admin",
      actor: modActor,
      action: { kind: "member.kick", member: target(["admin"]) },
      ok: false,
    },
    {
      name: "moderator cannot kick a peer",
      actor: modActor,
      action: { kind: "member.kick", member: target(["mod"]) },
      ok: false,
    },
    {
      name: "nobody acts against the owner",
      actor: adminActor,
      action: { kind: "member.timeout", member: target([], true) },
      ok: false,
    },
    {
      name: "moderator cannot ban (no BAN_MEMBERS)",
      actor: modActor,
      action: { kind: "member.ban", member: target([]) },
      ok: false,
    },
    {
      name: "admin bans a moderator",
      actor: adminActor,
      action: { kind: "member.ban", member: target(["mod"]) },
      ok: true,
    },
    {
      name: "own nickname needs CHANGE_NICKNAME",
      actor: plain,
      action: { kind: "member.nickname", member: target([]), self: true },
      ok: true,
    },
    {
      name: "other nicknames need rank",
      actor: modActor,
      action: { kind: "member.nickname", member: target(["admin"]), self: false },
      ok: false,
    },
    {
      name: "moderator renames a plain member",
      actor: modActor,
      action: { kind: "member.nickname", member: target([]), self: false },
      ok: true,
    },
    {
      name: "admin resets a plain member's password",
      actor: adminActor,
      action: { kind: "member.reset-password", member: target([]) },
      ok: true,
    },
    {
      name: "admin cannot reset the owner's password",
      actor: adminActor,
      action: { kind: "member.reset-password", member: target([], true) },
      ok: false,
    },
    {
      name: "moderator cannot reset passwords",
      actor: modActor,
      action: { kind: "member.reset-password", member: target([]) },
      ok: false,
    },
    {
      name: "overwrite within held bits",
      actor: adminActor,
      action: {
        kind: "overwrite.set",
        allow: PERM.SEND_MESSAGES,
        actorChannelPermissions: ADMIN_PERMISSIONS,
        role: roleFacts(mod),
      },
      ok: true,
    },
    {
      name: "overwrite cannot allow a bit the actor lacks in the channel",
      actor: adminActor,
      action: {
        kind: "overwrite.set",
        allow: PERM.SEND_MESSAGES,
        actorChannelPermissions: PERM.VIEW_CHANNEL,
        role: roleFacts(mod),
      },
      ok: false,
    },
    {
      name: "overwrite on a higher role is refused",
      actor: adminActor,
      action: {
        kind: "overwrite.set",
        allow: 0n,
        actorChannelPermissions: ADMIN_PERMISSIONS,
        role: roleFacts(superRole),
      },
      ok: false,
    },
    {
      name: "overwrite needs MANAGE_CHANNELS",
      actor: modActor,
      action: {
        kind: "overwrite.set",
        allow: 0n,
        actorChannelPermissions: MODERATOR_PERMISSIONS,
        role: roleFacts(muted),
      },
      ok: false,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(authorizeAction(c.actor, c.action).ok).toBe(c.ok);
    });
  }

  it("reports the missing permission", () => {
    const r = authorizeAction(plain, { kind: "role.create", position: 1, permissions: 0n });
    expect(r).toMatchObject({ ok: false, missing: "MANAGE_ROLES" });
  });

  it("property: nobody can grant a bit they do not hold, whoever they are", () => {
    const r = rng(9);
    for (let i = 0; i < 400; i++) {
      const { rs, m } = scenario(r);
      const a: ActorFacts = {
        isOwner: false,
        permissions: basePermissions(m, rs) | PERM.MANAGE_ROLES,
        rank: highestPosition(m, rs) + 5,
      };
      const wanted = randomBits(r);
      const res = authorizeAction(a, { kind: "role.create", position: 0, permissions: wanted });
      const lacking = wanted & ~a.permissions;
      expect(res.ok).toBe(lacking === 0n);
    }
  });
});

describe("bitsOf", () => {
  it("builds masks", () => {
    expect(bitsOf("VIEW_CHANNEL", "SEND_MESSAGES")).toBe(3n);
  });
});
