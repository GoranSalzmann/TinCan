// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { AppError } from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "./api.js";
import { getMember, listMembers, memberCount, spaceOf } from "./members.js";
import { Presence } from "./presence.js";
import { registerAccountRoutes } from "./routes.js";
import { accountsMigrations, type AccountsTables } from "./schema.js";
import { AccountsService } from "./service.js";
import { UserSettings } from "./settings.js";

const ConfigSchema = z.strictObject({
  signup: z.enum(["invite-only", "open", "closed"]).default("invite-only"),
  sessionIdleDays: z.number().int().min(1).max(365).default(30),
  sessionMaxDays: z.number().int().min(1).max(3650).default(90),
  /** 11 §1.1: 64 MiB, 3 iterations, parallelism 1; tune toward 150–300 ms on the Host's hardware. */
  argon2: z
    .strictObject({
      memoryKiB: z
        .number()
        .int()
        .min(1024)
        .default(64 * 1024),
      timeCost: z.number().int().min(1).default(3),
      parallelism: z.number().int().min(1).default(1),
    })
    .prefault({}),
});

/** Setup is the only way in until an owner exists, so every other API answers SETUP_REQUIRED (11 §1.4). */
const OPEN_BEFORE_SETUP = new Set([
  "/api/v1/capabilities",
  "/api/v1/auth/setup",
  "/api/v1/auth/setup/verify",
]);

export default defineModule({
  id: "accounts",
  version: VERSION,
  dependsOn: ["core"],
  requiresPorts: ["db", "auth", "pubsub"],
  alwaysOn: true,
  configSchema: ConfigSchema,
  migrations: accountsMigrations,
  async register(ctx) {
    const db = ctx.ports.db.as<AccountsTables>();
    const svc = new AccountsService({
      db,
      kv: ctx.ports.pubsub.kv,
      events: ctx.events,
      log: ctx.log,
      settings: ctx.config,
      dataDir: ctx.core.dataDir,
      instanceSecret: ctx.core.security.instanceSecret,
      defaultInstanceName: ctx.core.instance.name,
      broadcast: (t, d) => ctx.gateway.dispatchToAll(t, d),
    });
    svc.bindAuth(ctx.ports.auth.local({ lookup: (u) => svc.lookupCredential(u), params: ctx.config.argon2 }));
    await svc.init();

    const settings = new UserSettings(db);
    settings.register("appearance.theme", z.enum(["light", "dark", "system"]));
    settings.register("appearance.accent", z.string().min(1).max(32));
    settings.register("appearance.density", z.enum(["comfortable", "compact"]));
    settings.register("locale", z.string().min(2).max(16));
    const presence = new Presence(ctx.gateway);

    ctx.security.setAuthenticator({
      fromToken: (token) => svc.authenticateToken(token),
      fromTicket: (ticket) => svc.redeemGatewayTicket(ticket),
    });
    ctx.security.addGate((req) => {
      if (svc.setupRequired && !OPEN_BEFORE_SETUP.has(req.url.split("?")[0] ?? "")) {
        throw new AppError("SETUP_REQUIRED", "This server has not been set up yet.");
      }
    });
    ctx.capabilities.instance(() => ({
      name: svc.instanceName,
      signup: ctx.config.signup,
      setupRequired: svc.setupRequired,
    }));

    registerAccountRoutes(ctx.http, svc, {
      secureCookie: ctx.core.instance.publicUrl.startsWith("https:"),
      settings,
      notifyUser: (userId, t, d) => ctx.gateway.dispatchToUser(userId, t, d),
    });

    ctx.gateway.contributeReady(async (actor) => {
      const [instance, user, prefs] = await Promise.all([
        svc.getInstance(),
        svc.getUser(actor.userId),
        settings.get(actor.userId),
      ]);
      return {
        user: user && {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatarKey: user.avatarKey,
          isInstanceOwner: user.isInstanceOwner,
        },
        instance,
        presence: { ...presence.snapshot(), [actor.userId]: presence.statusIfConnected(actor.userId) },
        settings: prefs,
      };
    });

    const api: AccountsApi = {
      async getUser(id) {
        const u = await svc.getUser(id);
        return (
          u && {
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            avatarKey: u.avatarKey,
            isInstanceOwner: u.isInstanceOwner,
          }
        );
      },
      getUsers: (ids) => svc.getUsers(ids),
      async spaceId() {
        return (await spaceOf(db))?.id ?? null;
      },
      async ownerId() {
        return (await spaceOf(db))?.ownerId ?? null;
      },
      async userIdByUsername(username) {
        const row = await db.query
          .selectFrom("user")
          .select("id")
          .where("username", "=", username.toLowerCase())
          .executeTakeFirst();
        return row?.id ?? null;
      },
      issueResetCode: (userId) => svc.createResetCode(userId, null),
      listMembers: () => listMembers(db),
      getMember: (id) => getMember(db, id),
      memberCount: () => memberCount(db),
      instanceName: async () => (await svc.getInstance()).name,
      async setNickname(userId, nickname) {
        await db.query.updateTable("member").set({ nickname }).where("user_id", "=", userId).execute();
      },
      setAvatarKey: (userId, key) => svc.setAvatarKey(userId, key),
      revokeAllSessions: (userId) => svc.revokeAllSessions(userId),
      async setTimeoutUntil(userId, until) {
        await db.query
          .updateTable("member")
          .set({ timeout_until: until })
          .where("user_id", "=", userId)
          .execute();
      },
      setLoginBlocker: (b) => svc.setLoginBlocker(b),
      onMemberJoin: (hook) => svc.addJoinHook(hook),
      onMemberJoined: (hook) => svc.addJoinedHook(hook),
      setInviteRedeemer: (r) => svc.setRedeemer(r),
      setResetAuthorizer: (a) => svc.setResetAuthorizer(a),
      registerSetting: (key, schema) => settings.register(key, schema),
    };
    ctx.api.provide("accounts", api);

    ctx.jobs.every("sessions.purge", 60 * 60_000, async () => void (await svc.purgeSessions()));
    ctx.jobs.every("password-reset.purge", 60 * 60_000, async () => {
      await db.query
        .deleteFrom("password_reset")
        .where("expires_at", "<", Date.now() - 86_400_000)
        .execute();
    });
  },
});
