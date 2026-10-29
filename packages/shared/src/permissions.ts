// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Permission catalogue and the pure authorisation functions (11 §2). Bit positions are allocated here,
 * never reassigned, and do not depend on which modules are enabled. On the wire a bitset is the decimal
 * string of an unsigned 64-bit integer (18 T7); in code it is a `bigint`.
 */

export const PERMISSION_BITS = {
  VIEW_CHANNEL: 0,
  SEND_MESSAGES: 1,
  READ_HISTORY: 2,
  ATTACH_FILES: 3,
  EMBED_LINKS: 4,
  ADD_REACTIONS: 5,
  MENTION_EVERYONE: 6,
  MANAGE_MESSAGES: 7,
  CONNECT: 8,
  SPEAK: 9,
  VIDEO: 10,
  SCREEN_SHARE: 11,
  USE_VOICE_ACTIVITY: 12,
  MUTE_MEMBERS: 13,
  MOVE_MEMBERS: 14,
  MANAGE_CHANNELS: 15,
  MANAGE_ROLES: 16,
  CREATE_INVITE: 17,
  MANAGE_INVITES: 18,
  KICK_MEMBERS: 19,
  BAN_MEMBERS: 20,
  TIMEOUT_MEMBERS: 21,
  VIEW_AUDIT_LOG: 22,
  MANAGE_INSTANCE: 23,
  CHANGE_NICKNAME: 24,
  MANAGE_NICKNAMES: 25,
  ADMINISTRATOR: 26,
} as const;

export type PermissionName = keyof typeof PERMISSION_BITS;
export const PERMISSION_NAMES = Object.keys(PERMISSION_BITS) as PermissionName[];

export const PERM = Object.fromEntries(
  Object.entries(PERMISSION_BITS).map(([name, bit]) => [name, 1n << BigInt(bit)]),
) as Record<PermissionName, bigint>;

/** Every defined bit. What the owner and an administrator hold. */
export const ALL_PERMISSIONS: bigint = PERMISSION_NAMES.reduce((acc, n) => acc | PERM[n], 0n);

/** Bits that mean something per channel (scopes `channel`, `text`, `voice` in 11 §2.2). Overwrites can only touch these. */
export const CHANNEL_SCOPED: bigint = (1n << 15n) - 1n;

const TEXT_ONLY: bigint =
  PERM.SEND_MESSAGES |
  PERM.READ_HISTORY |
  PERM.ATTACH_FILES |
  PERM.EMBED_LINKS |
  PERM.ADD_REACTIONS |
  PERM.MENTION_EVERYONE |
  PERM.MANAGE_MESSAGES;
const VOICE_ONLY: bigint =
  PERM.CONNECT |
  PERM.SPEAK |
  PERM.VIDEO |
  PERM.SCREEN_SHARE |
  PERM.USE_VOICE_ACTIVITY |
  PERM.MUTE_MEMBERS |
  PERM.MOVE_MEMBERS;

/** What a timeout removes (11 §2.3 step 4). View and read stay. */
export const TIMEOUT_REMOVES: bigint =
  PERM.SEND_MESSAGES | PERM.ADD_REACTIONS | PERM.SPEAK | PERM.VIDEO | PERM.SCREEN_SHARE;

export type ChannelKind = "text" | "voice";

/** The channel-scoped bits that apply to a channel type; the rest are meaningless there. */
export function channelKindMask(kind: ChannelKind): bigint {
  return PERM.VIEW_CHANNEL | (kind === "text" ? TEXT_ONLY : VOICE_ONLY);
}

export function permissionsToString(p: bigint): string {
  return (p & ((1n << 64n) - 1n)).toString(10);
}

export function parsePermissions(s: string): bigint {
  if (!/^\d{1,20}$/.test(s)) throw new RangeError("permissions must be a decimal string");
  const v = BigInt(s);
  if (v >= 1n << 64n) throw new RangeError("permissions exceed 64 bits");
  return v;
}

export function has(p: bigint, perm: PermissionName): boolean {
  return (p & PERM[perm]) === PERM[perm];
}

export function bitsOf(...names: PermissionName[]): bigint {
  return names.reduce((acc, n) => acc | PERM[n], 0n);
}

export function namesOf(p: bigint): PermissionName[] {
  return PERMISSION_NAMES.filter((n) => (p & PERM[n]) !== 0n);
}

// ---- default roles (11 §2.2) ----------------------------------------------------------------

export const EVERYONE_PERMISSIONS: bigint = bitsOf(
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "READ_HISTORY",
  "ATTACH_FILES",
  "EMBED_LINKS",
  "ADD_REACTIONS",
  "CONNECT",
  "SPEAK",
  "VIDEO",
  "SCREEN_SHARE",
  "USE_VOICE_ACTIVITY",
  "CREATE_INVITE",
  "CHANGE_NICKNAME",
);

export const MODERATOR_PERMISSIONS: bigint =
  EVERYONE_PERMISSIONS |
  bitsOf(
    "MANAGE_MESSAGES",
    "MUTE_MEMBERS",
    "MOVE_MEMBERS",
    "KICK_MEMBERS",
    "TIMEOUT_MEMBERS",
    "VIEW_AUDIT_LOG",
    "MANAGE_NICKNAMES",
    "MENTION_EVERYONE",
  );

export const ADMIN_PERMISSIONS: bigint =
  MODERATOR_PERMISSIONS |
  bitsOf("MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_INVITES", "BAN_MEMBERS", "MANAGE_INSTANCE");

// ---- computation (11 §2.3) ------------------------------------------------------------------

export interface RoleFacts {
  id: string;
  /** Higher means more authority; `@everyone` is 0. */
  position: number;
  permissions: bigint;
}

export interface OverwriteFacts {
  targetType: "role" | "member";
  targetId: string;
  allow: bigint;
  deny: bigint;
}

export interface MemberFacts {
  userId: string;
  isOwner: boolean;
  /** Role IDs the member holds, not counting `@everyone`, which everyone has. */
  roleIds: readonly string[];
  /** True while `timeout_until` lies in the future. */
  timedOut?: boolean;
}

export interface RoleSet {
  /** The `@everyone` role. */
  everyone: RoleFacts;
  /** Every other role by ID. Unknown IDs in a member's list are ignored. */
  roles: ReadonlyMap<string, RoleFacts>;
}

function rolesOf(member: MemberFacts, set: RoleSet): RoleFacts[] {
  const out: RoleFacts[] = [];
  for (const id of member.roleIds) {
    const r = set.roles.get(id);
    if (r) out.push(r);
  }
  return out;
}

export function basePermissions(member: MemberFacts, set: RoleSet): bigint {
  if (member.isOwner) return ALL_PERMISSIONS;
  let p = set.everyone.permissions;
  for (const r of rolesOf(member, set)) p |= r.permissions;
  if ((p & PERM.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;
  return p & ALL_PERMISSIONS;
}

/** One line per step, for `tincan perms explain` and the effective-permissions preview (11 §4). */
export interface ExplainStep {
  step: string;
  before: bigint;
  after: bigint;
}

export function channelPermissions(
  member: MemberFacts,
  set: RoleSet,
  overwrites: readonly OverwriteFacts[],
  kind: ChannelKind = "text",
  trace?: ExplainStep[],
): bigint {
  const note = (step: string, before: bigint, after: bigint) => trace?.push({ step, before, after });
  let p = basePermissions(member, set);
  note("base (owner, @everyone and roles)", 0n, p);
  if (p === ALL_PERMISSIONS) return ALL_PERMISSIONS; // owner and administrator ignore overwrites

  const apply = (label: string, allow: bigint, deny: bigint) => {
    // Instance-wide bits cannot be changed per channel, whatever a stored row says.
    const before = p;
    p = (p & ~(deny & CHANNEL_SCOPED)) | (allow & CHANNEL_SCOPED);
    note(label, before, p);
  };

  const everyoneOw = overwrites.find((o) => o.targetType === "role" && o.targetId === set.everyone.id);
  if (everyoneOw) apply("@everyone overwrite", everyoneOw.allow, everyoneOw.deny);

  const heldRoleIds = new Set(rolesOf(member, set).map((r) => r.id));
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.targetType === "role" && heldRoleIds.has(o.targetId)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  if (allow !== 0n || deny !== 0n) apply("role overwrites (deny, then allow)", allow, deny);

  const memberOw = overwrites.find((o) => o.targetType === "member" && o.targetId === member.userId);
  if (memberOw) apply("member overwrite", memberOw.allow, memberOw.deny);

  // Implicit rules
  if ((p & PERM.VIEW_CHANNEL) === 0n) {
    const before = p;
    p &= ~CHANNEL_SCOPED;
    note("no VIEW_CHANNEL: channel bits removed", before, p);
  }
  if (member.timedOut) {
    const before = p;
    p &= ~TIMEOUT_REMOVES;
    note("timed out", before, p);
  }
  const before = p;
  p = (p & ~CHANNEL_SCOPED) | (p & channelKindMask(kind));
  if (p !== before) note(`bits that do not apply to a ${kind} channel`, before, p);
  return p;
}

// ---- hierarchy (11 §2.4) --------------------------------------------------------------------

/** The member's rank: owner above everything, otherwise the highest role position (`@everyone` is 0). */
export function highestPosition(member: MemberFacts, set: RoleSet): number {
  if (member.isOwner) return Number.POSITIVE_INFINITY;
  let top = set.everyone.position;
  for (const r of rolesOf(member, set)) top = Math.max(top, r.position);
  return top;
}

export interface ActorFacts {
  isOwner: boolean;
  /** `basePermissions` of the actor. */
  permissions: bigint;
  /** `highestPosition` of the actor. */
  rank: number;
}

export interface TargetMemberFacts {
  userId: string;
  isOwner: boolean;
  rank: number;
}

export interface TargetRoleFacts {
  position: number;
  permissions: bigint;
  isDefault?: boolean;
  isManaged?: boolean;
}

export type Action =
  | { kind: "role.create"; position: number; permissions: bigint }
  | { kind: "role.update"; role: TargetRoleFacts; newPosition?: number; newPermissions?: bigint }
  | { kind: "role.delete"; role: TargetRoleFacts }
  | { kind: "role.assign" | "role.unassign"; role: TargetRoleFacts; member: TargetMemberFacts }
  | {
      kind: "member.kick" | "member.ban" | "member.timeout" | "member.mute" | "member.move";
      member: TargetMemberFacts;
    }
  | { kind: "member.nickname"; member: TargetMemberFacts; self: boolean }
  | { kind: "member.reset-password"; member: TargetMemberFacts }
  | {
      /** Setting an overwrite: the allow bits must be ones the actor holds in that channel. */
      kind: "overwrite.set";
      allow: bigint;
      actorChannelPermissions: bigint;
      /** Present when the target is a role. */
      role?: TargetRoleFacts;
      /** Present when the target is a member. */
      member?: TargetMemberFacts;
    };

export type AuthResult =
  { ok: true } | { ok: false; reason: string; missing?: PermissionName; code: "PERMISSION_DENIED" };

const OK: AuthResult = { ok: true };
const deny = (reason: string, missing?: PermissionName): AuthResult => ({
  ok: false,
  code: "PERMISSION_DENIED",
  reason,
  ...(missing ? { missing } : {}),
});

const need = (actor: ActorFacts, perm: PermissionName): AuthResult | null =>
  actor.isOwner || has(actor.permissions, perm) ? null : deny(`you lack ${perm}`, perm);

/** Bits of `wanted` the actor does not hold. Owners and administrators hold everything. */
function escalation(actor: ActorFacts, wanted: bigint): bigint {
  return actor.isOwner ? 0n : wanted & ~actor.permissions;
}

/**
 * Whether `actor` may perform `action` (11 §2.4). One function, so the rules are in one place and
 * tested together. Pure: callers supply the facts.
 */
export function authorizeAction(actor: ActorFacts, action: Action): AuthResult {
  const above = (targetRank: number) => actor.isOwner || actor.rank > targetRank;
  const noEscalation = (wanted: bigint): AuthResult | null => {
    const extra = escalation(actor, wanted);
    return extra === 0n ? null : deny(`you cannot grant ${namesOf(extra).join(", ")}, which you do not hold`);
  };

  switch (action.kind) {
    case "role.create": {
      const e = need(actor, "MANAGE_ROLES") ?? noEscalation(action.permissions);
      if (e) return e;
      return above(action.position) ? OK : deny("a new role must rank below your highest role");
    }
    case "role.update": {
      const e = need(actor, "MANAGE_ROLES");
      if (e) return e;
      const r = action.role;
      // `@everyone` has no rank to outrank; MANAGE_ROLES is enough, and escalation is still checked.
      if (!r.isDefault && !above(r.position)) return deny("that role ranks at or above your highest role");
      if (r.isDefault && action.newPosition !== undefined) return deny("@everyone cannot be moved");
      if (action.newPermissions !== undefined) {
        // Only bits being added matter: keeping a bit the role already has is not an escalation.
        const added = action.newPermissions & ~r.permissions;
        const x = noEscalation(added);
        if (x) return x;
      }
      if (action.newPosition !== undefined && !above(action.newPosition))
        return deny("a role cannot be moved to or above your highest role");
      return OK;
    }
    case "role.delete": {
      const e = need(actor, "MANAGE_ROLES");
      if (e) return e;
      if (action.role.isDefault) return deny("@everyone cannot be deleted");
      if (action.role.isManaged) return deny("managed roles cannot be deleted");
      return above(action.role.position) ? OK : deny("that role ranks at or above your highest role");
    }
    case "role.assign":
    case "role.unassign": {
      const e = need(actor, "MANAGE_ROLES");
      if (e) return e;
      const { role, member } = action;
      if (role.isDefault) return deny("everyone already has @everyone");
      if (!above(role.position)) return deny("that role ranks at or above your highest role");
      if (action.kind === "role.assign") {
        const x = noEscalation(role.permissions);
        if (x) return x;
      }
      if (member.isOwner && !actor.isOwner) return deny("the owner cannot be changed");
      return above(member.rank) ? OK : deny("that member ranks at or above you");
    }
    case "member.kick":
    case "member.ban":
    case "member.timeout":
    case "member.mute":
    case "member.move": {
      const perm: PermissionName = {
        "member.kick": "KICK_MEMBERS",
        "member.ban": "BAN_MEMBERS",
        "member.timeout": "TIMEOUT_MEMBERS",
        "member.mute": "MUTE_MEMBERS",
        "member.move": "MOVE_MEMBERS",
      }[action.kind] as PermissionName;
      const e = need(actor, perm);
      if (e) return e;
      if (action.member.isOwner) return deny("nobody can act against the owner");
      return above(action.member.rank) ? OK : deny("that member ranks at or above you");
    }
    case "member.nickname": {
      if (action.self) return need(actor, "CHANGE_NICKNAME") ?? OK;
      const e = need(actor, "MANAGE_NICKNAMES");
      if (e) return e;
      if (action.member.isOwner && !actor.isOwner) return deny("the owner cannot be changed");
      return above(action.member.rank) ? OK : deny("that member ranks at or above you");
    }
    case "member.reset-password": {
      const e = need(actor, "MANAGE_INSTANCE");
      if (e) return e;
      if (action.member.isOwner && !actor.isOwner)
        return deny("only the owner can reset the owner's password");
      return above(action.member.rank) ? OK : deny("that member ranks at or above you");
    }
    case "overwrite.set": {
      const e = need(actor, "MANAGE_CHANNELS");
      if (e) return e;
      const extra = actor.isOwner ? 0n : action.allow & ~action.actorChannelPermissions;
      if (extra !== 0n)
        return deny(`you cannot allow ${namesOf(extra).join(", ")}, which you lack in this channel`);
      if (action.role && !action.role.isDefault && !above(action.role.position))
        return deny("that role ranks at or above your highest role");
      if (action.member) {
        if (action.member.isOwner && !actor.isOwner) return deny("the owner cannot be changed");
        if (!above(action.member.rank) && action.member.userId !== undefined && !actor.isOwner)
          return deny("that member ranks at or above you");
      }
      return OK;
    }
  }
}
