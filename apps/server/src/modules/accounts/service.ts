// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac, randomBytes } from "node:crypto";
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
  type SessionInfo,
  type SetupRequest,
  type User,
} from "@tincan/shared";
import type { EventBus } from "../../framework/events.js";
import type { Actor, Logger } from "../../framework/types.js";
import { enforceRateLimit } from "../../http/rate-limit.js";
import type { AccountsTables } from "./schema.js";
import { deleteSetupToken, ensureSetupToken, matchesSetupToken } from "./setup-token.js";
import { countUsers, createOwnerAndSpace, findUserById, findUserByUsername, toUser } from "./users.js";

const DAY = 86_400_000;
const TOUCH_AFTER_MS = 5 * 60_000;
const TICKET_TTL_MS = 30_000;
const AUTH_WINDOW_MS = 15 * 60_000;

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
}

/** Application layer of `accounts` (05 §2): authorises, orchestrates and publishes events. No HTTP types here. */
export class AccountsService {
  readonly #d: AccountsDeps;
  readonly #now: () => number;
  #auth!: LocalAuthAdapter;
  #setupComplete = false;
  #instanceName: string | null = null;

  constructor(deps: AccountsDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  bindAuth(adapter: LocalAuthAdapter): void {
    this.#auth = adapter;
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
      const owner = await createOwnerAndSpace(
        tx,
        { username: input.username, displayName: input.displayName, passwordHash, instanceName },
        now,
      );
      return this.#insertSession(tx, owner.id, meta, clientName, now, toUser(owner));
    });
    this.#setupComplete = true;
    this.#instanceName = instanceName;
    await deleteSetupToken(this.#d.dataDir);
    this.#d.events.emit("user.created", { userId: result.user.id });
    this.#d.log.info({ userId: result.user.id }, "owner account created; setup token deleted");
    return result;
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
