// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "@tincan/db";
import type {
  Action,
  ActorFacts,
  AuthResult,
  ChannelKind,
  OverwriteFacts,
  PermissionName,
  TargetMemberFacts,
  TargetRoleFacts,
} from "@tincan/shared";

export interface RoleRecord {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: bigint;
  isDefault: boolean;
  isManaged: boolean;
  hoist: boolean;
}

export interface ChannelFact {
  id: string;
  type: ChannelKind;
}

/**
 * What `roles` offers other modules (04 §5): the single `can()` of 05 §9, channel visibility for the
 * gateway, and the pieces `channels`, `invites` and `uploads` need to apply the hierarchy rules.
 */
export interface RolesApi {
  /** Effective permissions of a member in a channel (11 §2.3), cached per member and channel. */
  permissionsIn(userId: string, channelId: string): Promise<bigint>;
  /** Instance-wide permissions: roles and @everyone, without any channel overwrite. */
  basePermissions(userId: string): Promise<bigint>;
  can(userId: string, perm: PermissionName, channelId?: string): Promise<boolean>;
  /** Throws PERMISSION_DENIED naming the missing permission. */
  assert(userId: string, perm: PermissionName, channelId?: string): Promise<void>;
  /** Channels the member currently has VIEW_CHANNEL in. */
  visibleChannelIds(userId: string): Promise<Set<string>>;
  /** Effective permissions in every channel the member can see, as decimal strings. */
  channelPermissionMap(userId: string): Promise<Record<string, string>>;
  /** Tells `roles` which channels exist (and their type) after any create, delete or type change; pushes new visibility to live sockets. */
  syncChannels(channels: readonly ChannelFact[]): Promise<void>;
  /** Called per connected user whose visible channels changed (for CHANNEL_CREATE / CHANNEL_DELETE). */
  onVisibilityChange(fn: (userId: string, added: string[], removed: string[]) => void): void;
  listRoles(): Promise<RoleRecord[]>;
  getRole(id: string): Promise<RoleRecord | null>;
  roleIdsOf(userId: string): Promise<string[]>;
  actorFacts(userId: string): Promise<ActorFacts>;
  memberFacts(userId: string): Promise<TargetMemberFacts>;
  roleFacts(role: RoleRecord): TargetRoleFacts;
  authorize(userId: string, action: Action): Promise<AuthResult>;
  /** Throws PERMISSION_DENIED with the reason when `authorize` refuses. */
  authorizeOrThrow(userId: string, action: Action): Promise<void>;
  listOverwrites(channelId: string): Promise<OverwriteFacts[]>;
  setOverwrite(channelId: string, o: OverwriteFacts): Promise<void>;
  deleteOverwrite(channelId: string, targetType: "role" | "member", targetId: string): Promise<void>;
  /** Drops a deleted channel's overwrites inside the caller's transaction. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the caller's transaction, narrowed here
  deleteChannelOverwrites(tx: Db<any>, channelId: string): Promise<void>;
  /** Marks a member as timed out until `until` (epoch ms) or clears it; used by moderation (M5). */
  setTimeout(userId: string, until: number | null): Promise<void>;
  /** Steps of the computation for one member in one channel, for the admin preview and `perms explain`. */
  explain(
    userId: string,
    channelId: string,
  ): Promise<{ permissions: bigint; steps: { step: string; before: bigint; after: bigint }[] }>;
}
