// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import {
  ADMIN_PERMISSIONS,
  ALL_PERMISSIONS,
  AppError,
  EVERYONE_PERMISSIONS,
  MODERATOR_PERMISSIONS,
  authorizeAction,
  basePermissions,
  channelPermissions,
  has,
  highestPosition,
  newId,
  parsePermissions,
  permissionsToString,
  type Action,
  type ActorFacts,
  type AuthResult,
  type ChannelKind,
  type ExplainStep,
  type MemberFacts,
  type OverwriteFacts,
  type PermissionName,
  type RoleFacts,
  type RoleSet,
  type TargetMemberFacts,
  type TargetRoleFacts,
} from "@tincan/shared";
import type { EventBus } from "../../framework/events.js";
import type { GatewayRegistrar, Logger } from "../../framework/types.js";
import type { AccountsApi, MemberRecord } from "../accounts/api.js";
import type { ChannelFact, RoleRecord } from "./api.js";
import type { RolesTables } from "./schema.js";

export interface RolesDeps {
  db: Db<RolesTables>;
  accounts: AccountsApi;
  gateway: GatewayRegistrar;
  events: EventBus;
  log: Logger;
}

type VisibilityListener = (userId: string, added: string[], removed: string[]) => void;

const toRecord = (r: RolesTables["role"]): RoleRecord => ({
  id: r.id,
  name: r.name,
  color: r.color,
  position: r.position,
  permissions: BigInt(r.permissions),
  isDefault: r.is_default === 1,
  isManaged: r.is_managed === 1,
  hoist: r.hoist === 1,
});

/**
 * The permission service of `roles`: loads roles, assignments and overwrites into memory (a few hundred
 * rows at v1 scale), answers `can()` from the pure engine in `@tincan/shared`, caches per (member, channel),
 * and tells live gateway sessions what changed (11 §2.5, §2.6).
 */
export class RolesService {
  readonly #d: RolesDeps;
  #loaded = false;
  #dirty = true;
  #everyone: RoleFacts = { id: "", position: 0, permissions: EVERYONE_PERMISSIONS };
  #defaultRole: RoleRecord = {
    id: "",
    name: "@everyone",
    color: null,
    position: 0,
    permissions: EVERYONE_PERMISSIONS,
    isDefault: true,
    isManaged: false,
    hoist: false,
  };
  #roles = new Map<string, RoleRecord>();
  #memberRoles = new Map<string, string[]>();
  #overwrites = new Map<string, OverwriteFacts[]>();
  #channels = new Map<string, ChannelKind>();
  #timeouts = new Map<string, number>();
  #ownerId: string | null = null;
  #spaceId: string | null = null;
  readonly #cache = new Map<string, bigint>();
  readonly #pushed = new Map<string, Set<string>>();
  readonly #visibility: VisibilityListener[] = [];
  #now: () => number;

  constructor(deps: RolesDeps, now: () => number = Date.now) {
    this.#d = deps;
    this.#now = now;
  }

  // ---- loading -------------------------------------------------------------------------------

  /** Flags the in-memory state stale; the next read reloads it. Used by join hooks that write in a not yet committed transaction. */
  markDirty(): void {
    this.#dirty = true;
  }

  async #ensure(): Promise<void> {
    if (this.#loaded && !this.#dirty) return;
    // Cleared first: a read that lands while this runs reloads again rather than trusting half-loaded state.
    this.#dirty = false;
    const db = this.#d.db;
    const [roles, assigned, ows, members, ownerId, spaceId] = await Promise.all([
      db.query.selectFrom("role").selectAll().execute(),
      db.query.selectFrom("member_role").select(["user_id", "role_id"]).execute(),
      db.query.selectFrom("channel_overwrite").selectAll().execute(),
      this.#d.accounts.listMembers(),
      this.#d.accounts.ownerId(),
      this.#d.accounts.spaceId(),
    ]);
    this.#roles = new Map(roles.filter((r) => r.is_default !== 1).map((r) => [r.id, toRecord(r)]));
    const def = roles.find((r) => r.is_default === 1);
    this.#everyone = def
      ? { id: def.id, position: 0, permissions: BigInt(def.permissions) }
      : { id: "", position: 0, permissions: EVERYONE_PERMISSIONS };
    if (def) this.#defaultRole = toRecord(def);
    this.#memberRoles = new Map();
    for (const a of assigned) {
      const list = this.#memberRoles.get(a.user_id);
      if (list) list.push(a.role_id);
      else this.#memberRoles.set(a.user_id, [a.role_id]);
    }
    this.#overwrites = new Map();
    for (const o of ows) {
      const facts: OverwriteFacts = {
        targetType: o.target_type === "member" ? "member" : "role",
        targetId: o.target_id,
        allow: BigInt(o.allow),
        deny: BigInt(o.deny),
      };
      const list = this.#overwrites.get(o.channel_id);
      if (list) list.push(facts);
      else this.#overwrites.set(o.channel_id, [facts]);
    }
    this.#timeouts = new Map(
      members.filter((m) => m.timeoutUntil !== null).map((m) => [m.userId, m.timeoutUntil!]),
    );
    this.#ownerId = ownerId;
    this.#spaceId = spaceId;
    this.#cache.clear();
    this.#loaded = true;
  }

  /** Creates `@everyone`, Moderator and Admin when none exist (11 §1.4). Idempotent. */
  async ensureDefaults(tx: Db<RolesTables>, spaceId: string): Promise<void> {
    const have = await tx.query
      .selectFrom("role")
      .select("id")
      .where("space_id", "=", spaceId)
      .limit(1)
      .executeTakeFirst();
    if (have) return;
    const now = this.#now();
    const rows: RolesTables["role"][] = [
      ["@everyone", 0, EVERYONE_PERMISSIONS, 1, null, 0],
      ["Moderator", 1, MODERATOR_PERMISSIONS, 0, "#3ba55d", 1],
      ["Admin", 2, ADMIN_PERMISSIONS, 0, "#e5a23d", 1],
    ].map(([name, position, perms, isDefault, color, hoist]) => ({
      id: newId(now),
      space_id: spaceId,
      name: name as string,
      color: color as string | null,
      position: position as number,
      permissions: permissionsToString(perms as bigint),
      is_default: isDefault as number,
      is_managed: 0,
      hoist: hoist as number,
      created_at: now,
    }));
    await tx.query.insertInto("role").values(rows).execute();
    this.markDirty();
  }

  /** Grants the invite's default role to a new member inside the registration transaction. */
  async grantOnJoin(
    tx: Db<RolesTables>,
    spaceId: string,
    userId: string,
    roleId: string | null,
  ): Promise<void> {
    if (roleId) {
      const role = await tx.query
        .selectFrom("role")
        .select(["id", "is_default"])
        .where("id", "=", roleId)
        .executeTakeFirst();
      if (role && role.is_default !== 1) {
        await tx.query
          .insertInto("member_role")
          .values({ space_id: spaceId, user_id: userId, role_id: roleId })
          .execute();
      }
    }
    this.markDirty();
  }

  // ---- facts ---------------------------------------------------------------------------------

  async #member(userId: string): Promise<MemberFacts> {
    await this.#ensure();
    const until = this.#timeouts.get(userId);
    return {
      userId,
      isOwner: userId === this.#ownerId,
      roleIds: this.#memberRoles.get(userId) ?? [],
      timedOut: until !== undefined && until > this.#now(),
    };
  }

  #roleSet(): RoleSet {
    return {
      everyone: this.#everyone,
      roles: new Map(
        [...this.#roles].map(([id, r]) => [id, { id, position: r.position, permissions: r.permissions }]),
      ),
    };
  }

  async basePermissions(userId: string): Promise<bigint> {
    return basePermissions(await this.#member(userId), this.#roleSet());
  }

  async permissionsIn(userId: string, channelId: string): Promise<bigint> {
    await this.#ensure();
    const kind = this.#channels.get(channelId);
    if (!kind) return 0n; // unknown, archived or deleted channel: nothing is allowed
    const key = `${userId}|${channelId}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined) return hit;
    const p = channelPermissions(
      await this.#member(userId),
      this.#roleSet(),
      this.#overwrites.get(channelId) ?? [],
      kind,
    );
    this.#cache.set(key, p);
    return p;
  }

  async can(userId: string, perm: PermissionName, channelId?: string): Promise<boolean> {
    const p =
      channelId === undefined
        ? await this.basePermissions(userId)
        : await this.permissionsIn(userId, channelId);
    return has(p, perm);
  }

  async assert(userId: string, perm: PermissionName, channelId?: string): Promise<void> {
    if (!(await this.can(userId, perm, channelId))) {
      throw new AppError("PERMISSION_DENIED", "You do not have permission to do that.", { missing: perm });
    }
  }

  async visibleChannelIds(userId: string): Promise<Set<string>> {
    await this.#ensure();
    const out = new Set<string>();
    for (const id of this.#channels.keys()) {
      if (has(await this.permissionsIn(userId, id), "VIEW_CHANNEL")) out.add(id);
    }
    return out;
  }

  async channelPermissionMap(userId: string): Promise<Record<string, string>> {
    await this.#ensure();
    const out: Record<string, string> = {};
    for (const id of this.#channels.keys()) {
      const p = await this.permissionsIn(userId, id);
      if (has(p, "VIEW_CHANNEL")) out[id] = permissionsToString(p);
    }
    return out;
  }

  async explain(userId: string, channelId: string) {
    await this.#ensure();
    const kind = this.#channels.get(channelId);
    if (!kind) throw new AppError("NOT_FOUND", "No such channel.");
    const trace: ExplainStep[] = [];
    const permissions = channelPermissions(
      await this.#member(userId),
      this.#roleSet(),
      this.#overwrites.get(channelId) ?? [],
      kind,
      trace,
    );
    return { permissions, steps: trace };
  }

  // ---- hierarchy facts -----------------------------------------------------------------------

  async actorFacts(userId: string): Promise<ActorFacts> {
    const m = await this.#member(userId);
    const set = this.#roleSet();
    return { isOwner: m.isOwner, permissions: basePermissions(m, set), rank: highestPosition(m, set) };
  }

  async memberFacts(userId: string): Promise<TargetMemberFacts> {
    const m = await this.#member(userId);
    return { userId, isOwner: m.isOwner, rank: highestPosition(m, this.#roleSet()) };
  }

  roleFacts(role: RoleRecord): TargetRoleFacts {
    return {
      position: role.position,
      permissions: role.permissions,
      isDefault: role.isDefault,
      isManaged: role.isManaged,
    };
  }

  async authorize(userId: string, action: Action): Promise<AuthResult> {
    return authorizeAction(await this.actorFacts(userId), action);
  }

  async authorizeOrThrow(userId: string, action: Action): Promise<void> {
    const r = await this.authorize(userId, action);
    if (!r.ok) {
      throw new AppError("PERMISSION_DENIED", `You cannot do that: ${r.reason}.`, {
        reason: r.reason,
        ...(r.missing ? { missing: r.missing } : {}),
      });
    }
  }

  // ---- roles ---------------------------------------------------------------------------------

  async listRoles(): Promise<RoleRecord[]> {
    await this.#ensure();
    return [this.#defaultRole, ...[...this.#roles.values()].sort((a, b) => a.position - b.position)];
  }

  async getRole(id: string): Promise<RoleRecord | null> {
    return (await this.listRoles()).find((r) => r.id === id) ?? null;
  }

  async roleIdsOf(userId: string): Promise<string[]> {
    await this.#ensure();
    return [...(this.#memberRoles.get(userId) ?? [])];
  }

  async roleIdsByUser(): Promise<Map<string, string[]>> {
    await this.#ensure();
    return this.#memberRoles;
  }

  /** Places a role at `position` among the others and renumbers 1..n, keeping the order of everything else. */
  async #renumber(tx: Db<RolesTables>, orderedIds: string[]): Promise<void> {
    for (const [i, id] of orderedIds.entries()) {
      await tx.query
        .updateTable("role")
        .set({ position: i + 1 })
        .where("id", "=", id)
        .execute();
    }
  }

  async createRole(
    actorId: string,
    input: {
      name: string;
      color?: string | null | undefined;
      permissions?: string | undefined;
      hoist?: boolean | undefined;
      position?: number | undefined;
    },
  ): Promise<RoleRecord> {
    await this.#ensure();
    const permissions = input.permissions === undefined ? 0n : this.#parse(input.permissions);
    const position = input.position ?? 1;
    await this.authorizeOrThrow(actorId, { kind: "role.create", position, permissions });
    if (!this.#spaceId) throw new AppError("SETUP_REQUIRED", "This server has not been set up yet.");
    const id = newId(this.#now());
    const created = await this.#d.db.transaction(async (tx) => {
      const existing = await tx.query
        .selectFrom("role")
        .select(["id", "position"])
        .where("is_default", "=", 0)
        .orderBy("position")
        .execute();
      const order = existing.map((r) => r.id);
      order.splice(Math.min(Math.max(position, 1), order.length + 1) - 1, 0, id);
      await tx.query
        .insertInto("role")
        .values({
          id,
          space_id: this.#spaceId!,
          name: input.name,
          color: input.color ?? null,
          position: 0,
          permissions: permissionsToString(permissions),
          is_default: 0,
          is_managed: 0,
          hoist: input.hoist ? 1 : 0,
          created_at: this.#now(),
        })
        .execute();
      await this.#renumber(tx, order);
    });
    void created;
    this.markDirty();
    const role = (await this.getRole(id))!;
    this.#d.gateway.dispatchToAll("ROLE_CREATE", { role: wire(role) });
    await this.#changed("all");
    return role;
  }

  async updateRole(
    actorId: string,
    id: string,
    patch: {
      name?: string | undefined;
      color?: string | null | undefined;
      permissions?: string | undefined;
      hoist?: boolean | undefined;
      position?: number | undefined;
    },
  ): Promise<RoleRecord> {
    const role = await this.getRole(id);
    if (!role) throw new AppError("NOT_FOUND", "No such role.");
    const newPermissions = patch.permissions === undefined ? undefined : this.#parse(patch.permissions);
    await this.authorizeOrThrow(actorId, {
      kind: "role.update",
      role: this.roleFacts(role),
      ...(newPermissions === undefined ? {} : { newPermissions }),
      ...(patch.position === undefined ? {} : { newPosition: patch.position }),
    });
    await this.#d.db.transaction(async (tx) => {
      const set: Partial<RolesTables["role"]> = {};
      if (patch.name !== undefined && !role.isDefault) set.name = patch.name;
      if (patch.color !== undefined && !role.isDefault) set.color = patch.color;
      if (patch.hoist !== undefined && !role.isDefault) set.hoist = patch.hoist ? 1 : 0;
      if (newPermissions !== undefined) set.permissions = permissionsToString(newPermissions);
      if (Object.keys(set).length > 0)
        await tx.query.updateTable("role").set(set).where("id", "=", id).execute();
      if (patch.position !== undefined && !role.isDefault) {
        const others = await tx.query
          .selectFrom("role")
          .select("id")
          .where("is_default", "=", 0)
          .where("id", "!=", id)
          .orderBy("position")
          .execute();
        const order = others.map((r) => r.id);
        order.splice(Math.min(Math.max(patch.position, 1), order.length + 1) - 1, 0, id);
        await this.#renumber(tx, order);
      }
    });
    this.markDirty();
    const updated = (await this.getRole(id))!;
    this.#d.gateway.dispatchToAll("ROLE_UPDATE", { role: wire(updated) });
    // Moving a role changes other roles' positions too; clients re-sort from the full list.
    if (patch.position !== undefined) {
      for (const r of await this.listRoles())
        if (r.id !== id) this.#d.gateway.dispatchToAll("ROLE_UPDATE", { role: wire(r) });
    }
    await this.#changed("all");
    return updated;
  }

  async deleteRole(actorId: string, id: string): Promise<void> {
    const role = await this.getRole(id);
    if (!role) throw new AppError("NOT_FOUND", "No such role.");
    await this.authorizeOrThrow(actorId, { kind: "role.delete", role: this.roleFacts(role) });
    await this.#d.db.transaction(async (tx) => {
      await tx.query
        .deleteFrom("channel_overwrite")
        .where("target_type", "=", "role")
        .where("target_id", "=", id)
        .execute();
      await tx.query.deleteFrom("role").where("id", "=", id).execute(); // member_role rows cascade
      const rest = await tx.query
        .selectFrom("role")
        .select("id")
        .where("is_default", "=", 0)
        .orderBy("position")
        .execute();
      await this.#renumber(
        tx,
        rest.map((r) => r.id),
      );
    });
    this.markDirty();
    this.#d.gateway.dispatchToAll("ROLE_DELETE", { roleId: id });
    for (const r of await this.listRoles())
      if (!r.isDefault) this.#d.gateway.dispatchToAll("ROLE_UPDATE", { role: wire(r) });
    await this.#changed("all");
  }

  async assignRole(actorId: string, userId: string, roleId: string): Promise<void> {
    await this.#changeAssignment("role.assign", actorId, userId, roleId);
  }

  async unassignRole(actorId: string, userId: string, roleId: string): Promise<void> {
    await this.#changeAssignment("role.unassign", actorId, userId, roleId);
  }

  async #changeAssignment(
    kind: "role.assign" | "role.unassign",
    actorId: string,
    userId: string,
    roleId: string,
  ): Promise<void> {
    const [role, target] = await Promise.all([this.getRole(roleId), this.#d.accounts.getMember(userId)]);
    if (!role || !target) throw new AppError("NOT_FOUND", "No such role or member.");
    await this.authorizeOrThrow(actorId, {
      kind,
      role: this.roleFacts(role),
      member: await this.memberFacts(userId),
    });
    if (!this.#spaceId) throw new AppError("SETUP_REQUIRED", "This server has not been set up yet.");
    if (kind === "role.assign") {
      await this.#d.db.query
        .insertInto("member_role")
        .values({ space_id: this.#spaceId, user_id: userId, role_id: roleId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    } else {
      await this.#d.db.query
        .deleteFrom("member_role")
        .where("user_id", "=", userId)
        .where("role_id", "=", roleId)
        .execute();
    }
    this.markDirty();
    await this.#changed([userId]);
    this.#d.events.emit("permissions.changed", { userIds: [userId] });
    await this.announceMember(userId);
  }

  async announceMember(userId: string): Promise<void> {
    const rec = await this.#d.accounts.getMember(userId);
    if (!rec) return;
    this.#d.gateway.dispatchToAll("MEMBER_UPDATE", { member: await this.memberDto(rec) });
  }

  async memberDto(rec: MemberRecord) {
    const roleIds = await this.roleIdsOf(rec.userId);
    return {
      userId: rec.userId,
      username: rec.username,
      displayName: rec.displayName,
      avatarKey: rec.avatarKey,
      statusText: rec.statusText,
      nickname: rec.nickname,
      joinedAt: new Date(rec.joinedAt).toISOString(),
      roleIds,
      isOwner: rec.isOwner,
    };
  }

  // ---- overwrites ----------------------------------------------------------------------------

  async listOverwrites(channelId: string): Promise<OverwriteFacts[]> {
    await this.#ensure();
    return [...(this.#overwrites.get(channelId) ?? [])];
  }

  async setOverwrite(channelId: string, o: OverwriteFacts): Promise<void> {
    const id = newId(this.#now());
    const allow = permissionsToString(o.allow);
    const deny = permissionsToString(o.deny);
    await this.#d.db.query
      .insertInto("channel_overwrite")
      .values({ id, channel_id: channelId, target_type: o.targetType, target_id: o.targetId, allow, deny })
      .onConflict((oc) => oc.columns(["channel_id", "target_type", "target_id"]).doUpdateSet({ allow, deny }))
      .execute();
    this.markDirty();
    await this.#changed("all", channelId);
  }

  async deleteOverwrite(channelId: string, targetType: "role" | "member", targetId: string): Promise<void> {
    await this.#d.db.query
      .deleteFrom("channel_overwrite")
      .where("channel_id", "=", channelId)
      .where("target_type", "=", targetType)
      .where("target_id", "=", targetId)
      .execute();
    this.markDirty();
    await this.#changed("all", channelId);
  }

  async deleteChannelOverwrites(tx: Db<RolesTables>, channelId: string): Promise<void> {
    await tx.query.deleteFrom("channel_overwrite").where("channel_id", "=", channelId).execute();
    this.markDirty();
  }

  async setTimeout(userId: string, until: number | null): Promise<void> {
    await this.#ensure();
    if (until === null) this.#timeouts.delete(userId);
    else this.#timeouts.set(userId, until);
    this.#cache.clear();
    await this.#changed([userId]);
  }

  // ---- propagation (11 §2.6) -----------------------------------------------------------------

  onVisibilityChange(fn: VisibilityListener): void {
    this.#visibility.push(fn);
  }

  async syncChannels(channels: readonly ChannelFact[]): Promise<void> {
    await this.#ensure();
    this.#channels = new Map(channels.map((c) => [c.id, c.type]));
    this.#cache.clear();
    await this.#changed("all");
  }

  /** The visibility set a new gateway session starts with; also the baseline later diffs compare against. */
  async accessFor(userId: string): Promise<ReadonlySet<string>> {
    const set = await this.visibleChannelIds(userId);
    this.#pushed.set(userId, set);
    return set;
  }

  /**
   * Recomputes what the affected live users can see, replaces their gateway subscriptions, tells the
   * channels module which channels appeared or vanished for them, and sends `PERMISSIONS_UPDATE`.
   * Awaited by the mutation, so a REST success means enforcement is already in place (SLO ≤ 2 s, 11 §2.6).
   */
  async #changed(users: string[] | "all", _channelId?: string): Promise<void> {
    await this.#ensure();
    this.#cache.clear();
    const targets =
      users === "all" ? this.#d.gateway.onlineUserIds() : users.filter((u) => this.#d.gateway.isOnline(u));
    for (const userId of targets) {
      const next = await this.visibleChannelIds(userId);
      const prev = this.#pushed.get(userId) ?? new Set<string>();
      const added = [...next].filter((c) => !prev.has(c));
      const removed = [...prev].filter((c) => !next.has(c));
      this.#pushed.set(userId, next);
      this.#d.gateway.setChannelAccess(userId, next);
      for (const l of this.#visibility) l(userId, added, removed);
      this.#d.gateway.dispatchToUser(userId, "PERMISSIONS_UPDATE", {
        permissions: permissionsToString(await this.basePermissions(userId)),
        channels: await this.channelPermissionMap(userId),
      });
    }
    this.#d.events.emit("permissions.changed", { userIds: users });
  }

  #parse(s: string): bigint {
    try {
      const p = parsePermissions(s);
      // Only defined bits are stored; reserved bits stay zero.
      return p & ALL_PERMISSIONS;
    } catch {
      throw new AppError("VALIDATION_FAILED", "Permissions must be a decimal bitset.");
    }
  }

  get spaceId(): string | null {
    return this.#spaceId;
  }

  async ownerId(): Promise<string | null> {
    await this.#ensure();
    return this.#ownerId;
  }

  async channelKind(channelId: string): Promise<ChannelKind | undefined> {
    await this.#ensure();
    return this.#channels.get(channelId);
  }
}

export function wire(r: RoleRecord) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    position: r.position,
    permissions: permissionsToString(r.permissions),
    isDefault: r.isDefault,
    isManaged: r.isManaged,
    hoist: r.hoist,
  };
}
