// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { AppError } from "@tincan/shared";
import { defineModule } from "../../framework/types.js";
import { VERSION } from "../../version.js";
import type { AccountsApi } from "./api.js";
import { registerAccountRoutes } from "./routes.js";
import { accountsMigrations, type AccountsTables } from "./schema.js";
import { AccountsService } from "./service.js";

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
    });
    svc.bindAuth(ctx.ports.auth.local({ lookup: (u) => svc.lookupCredential(u), params: ctx.config.argon2 }));
    await svc.init();

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

    registerAccountRoutes(ctx.http, svc, { secureCookie: ctx.core.instance.publicUrl.startsWith("https:") });

    ctx.gateway.contributeReady(async (actor) => {
      const [instance, user] = await Promise.all([svc.getInstance(), svc.getUser(actor.userId)]);
      return {
        user: user && {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          isInstanceOwner: user.isInstanceOwner,
        },
        instance,
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
    };
    ctx.api.provide("accounts", api);

    ctx.jobs.every("sessions.purge", 60 * 60_000, async () => void (await svc.purgeSessions()));
  },
});
