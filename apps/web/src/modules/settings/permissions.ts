// SPDX-License-Identifier: AGPL-3.0-or-later
import { PERM, parsePermissions, permissionsToString, type PermissionName } from "@tincan/shared";

/** The permission catalogue grouped for the editors (W-40, W-41); order follows 11 §2.2. */
export const TEXT_PERMISSIONS: PermissionName[] = [
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "READ_HISTORY",
  "ATTACH_FILES",
  "EMBED_LINKS",
  "ADD_REACTIONS",
  "MENTION_EVERYONE",
  "MANAGE_MESSAGES",
];
export const VOICE_PERMISSIONS: PermissionName[] = [
  "CONNECT",
  "SPEAK",
  "VIDEO",
  "SCREEN_SHARE",
  "USE_VOICE_ACTIVITY",
  "MUTE_MEMBERS",
  "MOVE_MEMBERS",
];
export const SERVER_PERMISSIONS: PermissionName[] = [
  "MANAGE_CHANNELS",
  "MANAGE_ROLES",
  "CREATE_INVITE",
  "MANAGE_INVITES",
  "KICK_MEMBERS",
  "BAN_MEMBERS",
  "TIMEOUT_MEMBERS",
  "VIEW_AUDIT_LOG",
  "MANAGE_INSTANCE",
  "CHANGE_NICKNAME",
  "MANAGE_NICKNAMES",
  "ADMINISTRATOR",
];

export type Tri = "inherit" | "allow" | "deny";

export function triOf(allow: bigint, deny: bigint, name: PermissionName): Tri {
  return (deny & PERM[name]) !== 0n ? "deny" : (allow & PERM[name]) !== 0n ? "allow" : "inherit";
}

export function withTri(
  allow: bigint,
  deny: bigint,
  name: PermissionName,
  tri: Tri,
): { allow: bigint; deny: bigint } {
  const bit = PERM[name];
  const a = allow & ~bit;
  const d = deny & ~bit;
  return tri === "allow"
    ? { allow: a | bit, deny: d }
    : tri === "deny"
      ? { allow: a, deny: d | bit }
      : { allow: a, deny: d };
}

export const toBig = (s: string): bigint => parsePermissions(s);
export const toStr = (b: bigint): string => permissionsToString(b);
