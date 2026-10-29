// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { LocalAuthAdapter } from "@tincan/auth";
import {
  generateToken,
  hashPassword,
  hashToken,
  needsRehash,
  verifyPassword,
  type Argon2Params,
} from "@tincan/auth";
import type { Db } from "@tincan/db";
import type { Kv } from "@tincan/pubsub";
import {
  AppError,
  checkPassword,
  newId,
  type LoginRequest,
  type RegisterRequest,
  type SessionInfo,
  type SetupRequest,
  type User,
} from "@tincan/shared";
import type { EventBus } from "../../framework/events.js";
import type { Actor, Logger } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import type { InviteRedeemer, JoinHook, JoinedHook, JoinInfo, PublicUser, ResetAuthorizer } from "./api.js";
import type { AccountsTables } from "./schema.js";
import { deleteSetupToken, ensureSetupToken, matchesSetupToken } from "./setup-token.js";
import {
  countUsers,
  createOwnerAndSpace,
  findUserById,
  findUserByUsername,
  insertMember,
  insertUser,
  toUser,
} from "./users.js";

const DAY = 86_400_000;
const TOUCH_AFTER_MS = 5 * 60_000;
const TICKET_TTL_MS = 30_000;
const AUTH_WINDOW_MS = 15 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
/** No 0/O/1/I/L/U: a code read aloud or typed from a chat message survives. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function newResetCode(): string {
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join("")).join("-");
}

/** Codes are typed by people: ignore case, spaces and dashes. */
const normaliseCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");

export interface AccountsSettings {
  signup: "invite-only" | "open" | "closed";
  sessionIdleDays: number;
  sessionMaxDays: number;
  argon2: Argon2Params;
}

export interface ClientMeta {
  ip: string;
  userAgent: string;
}

export interface SessionResult {
  token: string;
  expiresAt: Date;
  user: User;
  sessionId: string;
  spaceId?: string;
  defaultRoleId?: string | null;
}

export interface AccountsDeps {
  db: Db<AccountsTables>;
  kv: Kv;
  events: EventBus;
  log: Logger;
  settings: AccountsSettings;
  dataDir: string;
  instanceSecret: string;
  defaultInstanceName: string;
  now?: () => number;
  /** Tells every connected client about a profile change (gateway). */
  broadcast?: (t: string, d: unknown) => void;
}

/** Application layer of `accounts` (05 §2): authorises, orchestrates and publishes events. No HTTP types here. */
export class AccountsService {
  readonly #d: AccountsDeps;
  readonly #now: () => number;
  #auth!: LocalAuthAdapter;
  #setupComplete = false;
  #instanceName: string | null = null;
  readonly #joinHooks: JoinHook[] = [];
  readonly #joinedHooks: JoinedHook[] = [];
  #redeemer: InviteRedeemer | null = null;
  #resetAuthorizer: ResetAuthorizer = { canReset: () => Promise.resolve(false) };

  constructor(deps: AccountsDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  bindAuth(adapter: LocalAuthAdapter): void {
    this.#auth = adapter;
  }

  addJoinHook(hook: JoinHook): void {
    this.#joinHooks.push(hook);
  }

  addJoinedHook(hook: JoinedHook): void {
    this.#joinedHooks.push(hook);
  }

  async #afterJoin(info: JoinInfo): Promise<void> {
    for (const hook of this.#joinedHooks) await hook(info);
  }

  setRedeemer(r: InviteRedeemer): void {
    this.#redeemer = r;
  }

  setResetAuthorizer(a: ResetAuthorizer): void {
    this.#resetAuthorizer = a;
  }

  async #runJoinHooks(tx: Db<AccountsTables>, info: JoinInfo): Promise<void> {
    for (const hook of this.#joinHooks) await hook(tx, info);
  }

  /** Loads first-run state; if the instance has no owner yet, makes sure the setup token exists and says where it is. */
  async init(): Promise<void> {
    this.#setupComplete = (await countUsers(this.#d.db)) > 0;
    await this.#loadInstanceName();
    if (!this.#setupComplete) {
      const { token, created } = await ensureSetupToken(this.#d.dataDir);
      this.#d.log.info(
        { setupToken: token, file: `${this.#d.dataDir}/setup-token` },
        created
          ? "First run: this server has no owner yet. Open /setup and enter the setup token."
          : "This server has no owner yet. Open /setup and enter the setup token.",
      );
    }
  }

  async #loadInstanceName(): Promise<void> {
    const space = await this.#d.db.query.selectFrom("space").select("name").limit(1).executeTakeFirst();
    this.#instanceName = space?.name ?? null;
  }

  get setupRequired(): boolean {
    return !this.#setupComplete;
  }

  get instanceName(): string | null {
    return this.#instanceName;
  }

  hashIp(ip: string): string {
    return createHmac("sha256", this.#d.instanceSecret).update(ip).digest("hex").slice(0, 32);
  }

  // ---- first-run setup (11 §1.4) -------------------------------------------------------------

  async verifySetupToken(token: string, ip: string): Promise<void> {
    if (this.#setupComplete) throw new AppError("CONFLICT", "This server is already set up.");
    await enforceRateLimit(this.#d.kv, { key: `setup:ip:${ip}`, max: 10, windowMs: AUTH_WINDOW_MS });
    if (!(await matchesSetupToken(this.#d.dataDir, token))) {
      throw new AppError("PERMISSION_DENIED", "That setup token does not match.", { reason: "setup_token" });
    }
  }

  async setup(input: SetupRequest, meta: ClientMeta, clientName: string): Promise<SessionResult> {
    await this.verifySetupToken(input.token, meta.ip);
    this.#checkPassword(input.password);
    const passwordHash = await hashPassword(input.password, this.#d.settings.argon2); // before the transaction: no non-DB await inside it
    const now = this.#now();
    const instanceName = input.instanceName ?? this.#d.defaultInstanceName;
    const result = await this.#d.db.transaction(async (tx) => {
      // BEGIN IMMEDIATE makes this check-then-insert atomic; the one-owner index is the backstop.
      if ((await countUsers(tx)) > 0) throw new AppError("CONFLICT", "This server is already set up.");
      const { owner, spaceId } = await createOwnerAndSpace(
        tx,
        { username: input.username, displayName: input.displayName, passwordHash, instanceName },
        now,
      );
      await this.#runJoinHooks(tx, { userId: owner.id, spaceId, isOwner: true, defaultRoleId: null });
      return { ...(await this.#insertSession(tx, owner.id, meta, clientName, now, toUser(owner))), spaceId };
    });
    this.#setupComplete = true;
    this.#instanceName = instanceName;
    await deleteSetupToken(this.#d.dataDir);
    await this.#afterJoin({
      userId: result.user.id,
      spaceId: result.spaceId,
      isOwner: true,
      defaultRoleId: null,
    });
    this.#d.events.emit("user.created", { userId: result.user.id });
    this.#d.events.emit("member.joined", { userId: result.user.id });
    this.#d.log.info({ userId: result.user.id }, "owner account created; setup token deleted");
    return result;
  }

  // ---- registration (11 §1.5) ----------------------------------------------------------------

  /** Creates a member with a password. Needs an invite unless signup is open; the invite use and the account commit together. */
  async register(input: RegisterRequest, meta: ClientMeta, clientName: string): Promise<SessionResult> {
    const policy = this.#d.settings.signup;
    if (policy === "closed")
      throw new AppError("PERMISSION_DENIED", "Registration is closed. Ask an admin to create your account.");
    // Invite codes are bearer secrets: slow down guessing (11 §5).
    await enforceRateLimit(this.#d.kv, { key: `register:ip:${meta.ip}`, max: 10, windowMs: AUTH_WINDOW_MS });
    if (input.inviteCode === undefined && policy !== "open")
      throw new AppError("PERMISSION_DENIED", "You need an invite to join this server.", {
        reason: "invite_required",
      });
    if (input.inviteCode !== undefined && !this.#redeemer)
      throw new AppError("FEATURE_DISABLED", "Invites are turned off on this server.");
    this.#checkPassword(input.password);
    const passwordHash = await hashPassword(input.password, this.#d.settings.argon2);
    const now = this.#now();
    const result = await this.#d.db.transaction(async (tx) => {
      const space = await tx.query.selectFrom("space").select("id").limit(1).executeTakeFirst();
      if (!space) throw new AppError("SETUP_REQUIRED", "This server has not been set up yet.");
      let row;
      try {
        row = await insertUser(
          tx,
          { username: input.username, displayName: input.displayName, passwordHash },
          now,
        );
      } catch (err) {
        if (/UNIQUE constraint failed: user\.username/.test((err as Error).message))
          throw new AppError("CONFLICT", "That username is taken.", { field: "username" });
        throw err;
      }
      await insertMember(tx, { spaceId: space.id, userId: row.id }, now);
      let defaultRoleId: string | null = null;
      if (input.inviteCode !== undefined) {
        defaultRoleId = (await this.#redeemer!.redeem(tx, input.inviteCode, row.id, now)).defaultRoleId;
      }
      await this.#runJoinHooks(tx, { userId: row.id, spaceId: space.id, isOwner: false, defaultRoleId });
      return {
        ...(await this.#insertSession(tx, row.id, meta, clientName, now, toUser(row))),
        spaceId: space.id,
        defaultRoleId,
      };
    });
    await this.#afterJoin({
      userId: result.user.id,
      spaceId: result.spaceId,
      isOwner: false,
      defaultRoleId: result.defaultRoleId,
    });
    this.#d.events.emit("user.created", { userId: result.user.id });
    this.#d.events.emit("member.joined", { userId: result.user.id });
    return result;
  }

  // ---- password reset codes (11 §1.6) --------------------------------------------------------

  /** Issues a one-time code for another user. A new code replaces any unused one. */
  async issueResetCode(
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ code: string; expiresAt: Date }> {
    const target = await findUserById(this.#d.db, targetUserId);
    if (!target) throw new AppError("NOT_FOUND", "No such user.");
    if (!(await this.#resetAuthorizer.canReset(actorUserId, targetUserId)))
      throw new AppError("PERMISSION_DENIED", "You cannot reset that password.");
    return this.createResetCode(targetUserId, actorUserId);
  }

  /** No authorisation here: the route (after its check) and the CLI have already decided. */
  async createResetCode(
    targetUserId: string,
    createdBy: string | null,
  ): Promise<{ code: string; expiresAt: Date }> {
    const code = newResetCode();
    const now = this.#now();
    const expiresAt = new Date(now + RESET_TTL_MS);
    await this.#d.db.transaction(async (tx) => {
      await tx.query
        .deleteFrom("password_reset")
        .where("user_id", "=", targetUserId)
        .where("used_at", "is", null)
        .execute();
      await tx.query
        .insertInto("password_reset")
        .values({
          id: newId(now),
          user_id: targetUserId,
          code_hash: sha256(normaliseCode(code)),
          created_by: createdBy,
          created_at: now,
          expires_at: expiresAt.getTime(),
          used_at: null,
        })
        .execute();
    });
    return { code, expiresAt };
  }

  /** Redeems a code: sets the password and signs the user out everywhere. Single use, claimed atomically. */
  async redeemResetCode(code: string, newPassword: string, ip: string): Promise<void> {
    await enforceRateLimit(this.#d.kv, { key: `reset:ip:${ip}`, max: 10, windowMs: AUTH_WINDOW_MS });
    this.#checkPassword(newPassword);
    const hash = await hashPassword(newPassword, this.#d.settings.argon2);
    const now = this.#now();
    const wanted = sha256(normaliseCode(code));
    const revoked = await this.#d.db.transaction(async (tx) => {
      const row = await tx.query
        .selectFrom("password_reset")
        .selectAll()
        .where("code_hash", "=", wanted)
        .executeTakeFirst();
      if (!row || row.used_at !== null || row.expires_at <= now)
        throw new AppError("NOT_FOUND", "That code is not valid or has expired.", { reason: "reset_code" });
      const claimed = await tx.query
        .updateTable("password_reset")
        .set({ used_at: now })
        .where("id", "=", row.id)
        .where("used_at", "is", null)
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0)
        throw new AppError("NOT_FOUND", "That code is not valid or has expired.", { reason: "reset_code" });
      await tx.query.updateTable("user").set({ password_hash: hash }).where("id", "=", row.user_id).execute();
      const live = await tx.query
        .selectFrom("session")
        .select("id")
        .where("user_id", "=", row.user_id)
        .where("revoked_at", "is", null)
        .execute();
      await tx.query
        .updateTable("session")
        .set({ revoked_at: now })
        .where("user_id", "=", row.user_id)
        .where("revoked_at", "is", null)
        .execute();
      return live.map((s) => ({ userId: row.user_id, sessionId: s.id }));
    });
    for (const r of revoked) this.#d.events.emit("session.revoked", r);
  }

  // ---- profile -------------------------------------------------------------------------------

  async patchProfile(
    userId: string,
    patch: { displayName?: string | undefined; statusText?: string | null | undefined },
  ): Promise<User> {
    const set: { display_name?: string; status_text?: string | null } = {};
    if (patch.displayName !== undefined) set.display_name = patch.displayName;
    if (patch.statusText !== undefined) set.status_text = patch.statusText === "" ? null : patch.statusText;
    if (Object.keys(set).length > 0)
      await this.#d.db.query.updateTable("user").set(set).where("id", "=", userId).execute();
    const row = await findUserById(this.#d.db, userId);
    if (!row) throw new AppError("NOT_FOUND", "No such user.");
    this.#announceUser(row);
    return toUser(row);
  }

  async setAvatarKey(userId: string, key: string | null): Promise<void> {
    await this.#d.db.query.updateTable("user").set({ avatar_key: key }).where("id", "=", userId).execute();
    const row = await findUserById(this.#d.db, userId);
    if (row) this.#announceUser(row);
  }

  #announceUser(row: {
    id: string;
    username: string;
    display_name: string;
    avatar_key: string | null;
    status_text: string | null;
  }): void {
    this.#d.broadcast?.("USER_UPDATE", {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarKey: row.avatar_key,
      statusText: row.status_text,
    });
  }

  async getUsers(ids: readonly string[]): Promise<Map<string, PublicUser>> {
    const out = new Map<string, PublicUser>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 200) {
      const rows = await this.#d.db.query
        .selectFrom("user")
        .select(["id", "username", "display_name", "avatar_key", "is_instance_owner"])
        .where("id", "in", unique.slice(i, i + 200))
        .execute();
      for (const r of rows)
        out.set(r.id, {
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          avatarKey: r.avatar_key,
          isInstanceOwner: r.is_instance_owner === 1,
        });
    }
    return out;
  }

  async renameInstance(name: string): Promise<{ name: string; ownerId: string | null }> {
    const space = await this.#d.db.query
      .selectFrom("space")
      .select(["id", "owner_user_id"])
      .limit(1)
      .executeTakeFirst();
    if (!space) throw new AppError("NOT_FOUND", "This server has not been set up yet.");
    await this.#d.db.query.updateTable("space").set({ name }).where("id", "=", space.id).execute();
    this.#instanceName = name;
    this.#d.events.emit("instance.updated", { name });
    return { name, ownerId: space.owner_user_id };
  }

  async getInstance(): Promise<{ name: string; ownerId: string | null }> {
    const space = await this.#d.db.query
      .selectFrom("space")
      .select(["name", "owner_user_id"])
      .limit(1)
      .executeTakeFirst();
    return { name: space?.name ?? this.#d.defaultInstanceName, ownerId: space?.owner_user_id ?? null };
  }

  // ---- login and sessions (11 §1.2, §1.3) ----------------------------------------------------

  #checkPassword(password: string): void {
    const problem = checkPassword(password);
    if (problem) {
      throw new AppError("VALIDATION_FAILED", "That password cannot be used.", {
        fields: { password: problem },
      });
    }
  }

  #expiry(createdAt: number, from: number): number {
    const s = this.#d.settings;
    return Math.min(from + s.sessionIdleDays * DAY, createdAt + s.sessionMaxDays * DAY);
  }

  async #insertSession(
    tx: Db<AccountsTables>,
    userId: string,
    meta: ClientMeta,
    clientName: string,
    now: number,
    user: User,
  ): Promise<SessionResult> {
    const token = generateToken();
    const id = newId(now);
    const expiresAt = this.#expiry(now, now);
    await tx.query
      .insertInto("session")
      .values({
        id,
        user_id: userId,
        token_hash: hashToken(token),
        created_at: now,
        last_used_at: now,
        expires_at: expiresAt,
        client_name: clientName.slice(0, 64),
        ip_hash: this.hashIp(meta.ip),
        user_agent: meta.userAgent.slice(0, 200),
        revoked_at: null,
      })
      .execute();
    return { token, expiresAt: new Date(expiresAt), user, sessionId: id };
  }

  async login(input: LoginRequest, meta: ClientMeta): Promise<SessionResult> {
    const username = input.username.trim().toLowerCase();
    // 07 §2.4: 10 / 15 min per IP, 5 / 15 min per username.
    await enforceRateLimit(this.#d.kv, { key: `login:ip:${meta.ip}`, max: 10, windowMs: AUTH_WINDOW_MS });
    await enforceRateLimit(this.#d.kv, {
      key: `login:user:${username.slice(0, 64)}`,
      max: 5,
      windowMs: AUTH_WINDOW_MS,
    });

    const identity = await this.#auth.authenticate({ username, password: input.password });
    // One message and one code path for unknown user and wrong password (11 §1.3).
    if (!identity) throw new AppError("UNAUTHENTICATED", "Username or password is incorrect.");
    const row = await findUserById(this.#d.db, identity.subject);
    if (!row) throw new AppError("UNAUTHENTICATED", "Username or password is incorrect.");
    if (row.disabled_at !== null) throw new AppError("ACCOUNT_DISABLED", "This account has been disabled.");

    await this.#d.kv.del(`rl:login:user:${username.slice(0, 64)}`);
    if (row.password_hash && needsRehash(row.password_hash, this.#d.settings.argon2)) {
      const upgraded = await hashPassword(input.password, this.#d.settings.argon2);
      await this.#d.db.query
        .updateTable("user")
        .set({ password_hash: upgraded })
        .where("id", "=", row.id)
        .execute();
    }
    const now = this.#now();
    return this.#d.db.transaction((tx) =>
      this.#insertSession(tx, row.id, meta, input.clientName ?? "Web", now, toUser(row)),
    );
  }

  async authenticateToken(token: string): Promise<Actor | null> {
    const now = this.#now();
    const row = await this.#d.db.query
      .selectFrom("session")
      .innerJoin("user", "user.id", "session.user_id")
      .select([
        "session.id as session_id",
        "session.created_at",
        "session.last_used_at",
        "session.expires_at",
        "session.revoked_at",
        "user.id as user_id",
        "user.username",
        "user.display_name",
        "user.disabled_at",
        "user.is_instance_owner",
      ])
      .where("session.token_hash", "=", hashToken(token))
      .executeTakeFirst();
    if (!row || row.revoked_at !== null || row.expires_at <= now || row.disabled_at !== null) return null;
    // Sliding expiry, throttled so reads do not become writes (11 §1.2).
    if (now - row.last_used_at > TOUCH_AFTER_MS) {
      await this.#d.db.query
        .updateTable("session")
        .set({ last_used_at: now, expires_at: this.#expiry(row.created_at, now) })
        .where("id", "=", row.session_id)
        .execute();
    }
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      username: row.username,
      displayName: row.display_name,
      isInstanceOwner: row.is_instance_owner === 1,
    };
  }

  async getUser(id: string): Promise<User | null> {
    const row = await findUserById(this.#d.db, id);
    return row ? toUser(row) : null;
  }

  async listSessions(userId: string, currentSessionId: string): Promise<SessionInfo[]> {
    const now = this.#now();
    const rows = await this.#d.db.query
      .selectFrom("session")
      .selectAll()
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now)
      .orderBy("last_used_at", "desc")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      clientName: r.client_name,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: new Date(r.last_used_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
      current: r.id === currentSessionId,
    }));
  }

  /** Revokes one of the user's own sessions. Returns false if there is no such live session. */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const res = await this.#d.db.query
      .updateTable("session")
      .set({ revoked_at: this.#now() })
      .where("id", "=", sessionId)
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) return false;
    this.#d.events.emit("session.revoked", { userId, sessionId });
    return true;
  }

  async changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    await enforceRateLimit(this.#d.kv, {
      key: `password:user:${actor.userId}`,
      max: 5,
      windowMs: AUTH_WINDOW_MS,
    });
    const row = await findUserById(this.#d.db, actor.userId);
    if (!row?.password_hash || !(await verifyPassword(row.password_hash, currentPassword))) {
      throw new AppError("PERMISSION_DENIED", "The current password is incorrect.", {
        reason: "current_password",
      });
    }
    this.#checkPassword(newPassword);
    const hash = await hashPassword(newPassword, this.#d.settings.argon2);
    const now = this.#now();
    const others = await this.#d.db.transaction(async (tx) => {
      await tx.query
        .updateTable("user")
        .set({ password_hash: hash })
        .where("id", "=", actor.userId)
        .execute();
      // A password change signs out every other device (11 §1.2).
      const live = await tx.query
        .selectFrom("session")
        .select("id")
        .where("user_id", "=", actor.userId)
        .where("id", "!=", actor.sessionId)
        .where("revoked_at", "is", null)
        .execute();
      await tx.query
        .updateTable("session")
        .set({ revoked_at: now })
        .where("user_id", "=", actor.userId)
        .where("id", "!=", actor.sessionId)
        .where("revoked_at", "is", null)
        .execute();
      return live.map((s) => s.id);
    });
    for (const sessionId of others)
      this.#d.events.emit("session.revoked", { userId: actor.userId, sessionId });
  }

  // ---- gateway tickets: the web session is an HttpOnly cookie that scripts cannot read ---------

  async issueGatewayTicket(actor: Actor): Promise<{ ticket: string; expiresInMs: number }> {
    const ticket = randomBytes(24).toString("base64url");
    await this.#d.kv.set(`gwticket:${ticket}`, JSON.stringify({ sessionId: actor.sessionId }), {
      ttlMs: TICKET_TTL_MS,
      nx: true,
    });
    return { ticket, expiresInMs: TICKET_TTL_MS };
  }

  /** Single use: the ticket is deleted as it is redeemed. */
  async redeemGatewayTicket(ticket: string): Promise<Actor | null> {
    const key = `gwticket:${ticket}`;
    const raw = await this.#d.kv.get(key);
    if (raw === null || !(await this.#d.kv.del(key))) return null;
    const { sessionId } = JSON.parse(raw) as { sessionId: string };
    const row = await this.#d.db.query
      .selectFrom("session")
      .select("token_hash")
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (!row) return null;
    // Re-validate through the same path as a token, so a revoked session cannot be revived by a ticket.
    return this.#authenticateHash(row.token_hash);
  }

  async #authenticateHash(tokenHash: string): Promise<Actor | null> {
    const row = await this.#d.db.query
      .selectFrom("session")
      .innerJoin("user", "user.id", "session.user_id")
      .select([
        "session.id as session_id",
        "session.expires_at",
        "session.revoked_at",
        "user.id as user_id",
        "user.username",
        "user.display_name",
        "user.disabled_at",
        "user.is_instance_owner",
      ])
      .where("session.token_hash", "=", tokenHash)
      .executeTakeFirst();
    if (!row || row.revoked_at !== null || row.expires_at <= this.#now() || row.disabled_at !== null)
      return null;
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      username: row.username,
      displayName: row.display_name,
      isInstanceOwner: row.is_instance_owner === 1,
    };
  }

  // ---- housekeeping --------------------------------------------------------------------------

  /** `sessions.purge` job (05 §7): expired sessions, and revoked ones after a day. */
  async purgeSessions(): Promise<number> {
    const now = this.#now();
    const res = await this.#d.db.query
      .deleteFrom("session")
      .where((eb) => eb.or([eb("expires_at", "<=", now), eb("revoked_at", "<", now - DAY)]))
      .executeTakeFirst();
    return Number(res.numDeletedRows);
  }

  /** Lookup the local auth adapter uses (never exposes the DB to packages/auth). */
  async lookupCredential(username: string) {
    const row = await findUserByUsername(this.#d.db, username);
    return row ? { userId: row.id, username: row.username, passwordHash: row.password_hash } : null;
  }
}
