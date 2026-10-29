// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from "zod";
import type { Db } from "@tincan/db";

/**
 * The read and extension interface `accounts` offers other modules (04 §5). Other modules import this
 * file's types and nothing else from here; they never touch the account tables.
 */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  isInstanceOwner: boolean;
}

export interface MemberRecord {
  userId: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  statusText: string | null;
  nickname: string | null;
  joinedAt: number;
  timeoutUntil: number | null;
  isOwner: boolean;
  disabled: boolean;
}

export interface JoinInfo {
  userId: string;
  spaceId: string;
  isOwner: boolean;
  /** Role the redeemed invite grants, if any. */
  defaultRoleId: string | null;
}

/** Runs inside the transaction that creates a member (setup, registration), so a module's seeding is atomic with it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the hook receives the shared transaction; it narrows it to its own tables
export type JoinHook = (tx: Db<any>, info: JoinInfo) => Promise<void>;

/** Runs after the member is committed and before the request answers, so the first thing the new member does sees consistent state. */
export type JoinedHook = (info: JoinInfo) => Promise<void>;

export interface InviteRedeemer {
  /**
   * Consumes one use of the invite inside the registration transaction, or throws an AppError
   * (NOT_FOUND, INVITE_EXPIRED, INVITE_EXHAUSTED). The new user already exists in `tx`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see JoinHook
  redeem(tx: Db<any>, code: string, userId: string, now: number): Promise<{ defaultRoleId: string | null }>;
}

export interface ResetAuthorizer {
  /** May `actorUserId` issue a password-reset code for `targetUserId`? */
  canReset(actorUserId: string, targetUserId: string): Promise<boolean>;
}

export interface AccountsApi {
  getUser(id: string): Promise<PublicUser | null>;
  getUsers(ids: readonly string[]): Promise<Map<string, PublicUser>>;
  /** The one space's ID, or null before setup. */
  spaceId(): Promise<string | null>;
  ownerId(): Promise<string | null>;
  userIdByUsername(username: string): Promise<string | null>;
  /** One-time password-reset code without an authorisation check: for the admin CLI, where being on the host is the authority (11 §1.6). */
  issueResetCode(userId: string): Promise<{ code: string; expiresAt: Date }>;
  listMembers(): Promise<MemberRecord[]>;
  getMember(userId: string): Promise<MemberRecord | null>;
  memberCount(): Promise<number>;
  instanceName(): Promise<string>;
  setNickname(userId: string, nickname: string | null): Promise<void>;
  /** Sets or clears the avatar key and tells connected clients. */
  setAvatarKey(userId: string, key: string | null): Promise<void>;
  onMemberJoin(hook: JoinHook): void;
  onMemberJoined(hook: JoinedHook): void;
  setInviteRedeemer(redeemer: InviteRedeemer): void;
  setResetAuthorizer(authorizer: ResetAuthorizer): void;
  /**
   * Allows a synced preference key (06 `user_setting`): an exact key or a prefix ending in `.*`.
   * The owning module registers its keys; anything unregistered is rejected.
   */
  registerSetting(keyOrPrefix: string, schema: z.ZodType): void;
}
